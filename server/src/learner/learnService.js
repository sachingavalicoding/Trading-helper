// @ts-check
import { createHash } from 'node:crypto';
import { LearnerState, OptionSettings, TradeDefaults, AutoSettings } from '../models/index.js';
import { rulesFor } from '../models/TradeDefaults.js';
import { normalizeCombos, MAX_COMBOS } from '../combos/combos.js';
import { CONDITION_BY_KEY } from '../combos/conditions.js';
import { stopRuleOf } from '../study/patterns.js';
import { trailOf, breakEvenOf } from '../study/simulate.js';
import { entryWindowOf } from '../options/signal.js';
import { LIVE_PATTERNS, DEFAULT_PATTERNS } from '../options/optionTrader.js';
import { istParts, isTradingDay } from '../market/marketHours.js';
import { badRequest, conflict } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { tune, steady, MIN_DAYS } from './tune.js';
import { tuneCombo, strip } from './comboTune.js';
import { tuneShares, shareSettingsOf, sharePatch, shareTrades } from './shareTune.js';
import { learnContext, dayKey } from './learnRun.js';

// Lab > Learn: runs the settings learner (tune.js) for a user in the background, keeps the last result, and applies it to the paper
// options settings on request. A result that failed on the hidden days is applied only with `force` (the screen asks first), and only
// while the settings are still the ones it learned from. Undo puts back what was there before the last apply.

/** @typedef {import('./tune.js').Settings} Settings */

export const KIND = 'tune';
export const LEARN_DAYS = [15, 20, 30];
export const INDEX = 'NIFTY';
const WARMUP_DAYS = 6;
const LOG_MAX = 30;
export const SEARCH_MS = 3 * 60_000; // the learner stops trying new changes after this long (a phone is slow) and judges what it found
export const COMBO_SEARCH_MS = 5 * 60_000; // all combinations together, shared out between them
export const MAX_TUNED = 12; // combinations tuned in one run, switched-on ones first
export const EVENING_AFTER_MIN = 17 * 60; // 17:00 IST: after the evening save of candles and option prices (and the auto-learner at 16:30)
const EVENING_TICK_MS = 10 * 60_000;
const TRACK_MAX = 20;
const WHAT = ['setup', 'combos', 'shares'];
export const SHARE_DAYS = 15; // the share candles saved are kept short (the shares study allows 15 days)
const SHARE_SEARCH_MS = 2 * 60_000;
export const FILL_SLIPPAGE = 0.005; // each option fill 0.5% worse than the price seen: the Replay test's default slippage

/**
 * The settings the learner can change, read from what is saved.
 * @param {any} s  OptionSettings (lean) or null
 * @param {any} defaults  TradeDefaults (lean) or null
 * @returns {Settings}
 */
export function settingsOf(s, defaults) {
  const rules = rulesFor(defaults, 'OPT');
  const win = entryWindowOf(s);
  return {
    combos: normalizeCombos(s?.combos ?? []).filter((c) => !c.index || c.index === INDEX),
    patternEntries: s?.patternEntries !== false,
    patterns: [...(s?.patterns ?? DEFAULT_PATTERNS)],
    maxTrades: s?.maxTrades ?? 3,
    dailyLossPct: s?.dailyLossPct ?? 10,
    lossLimit: rules.stopLoss,
    lossStreak: s?.lossStreak ?? 2,
    steps: rules.steps,
    stopRule: stopRuleOf(s),
    trail: trailOf(s),
    breakEven: breakEvenOf(s),
    entryFrom: win.from,
    entryTo: win.to,
  };
}

/** A short fingerprint of the settings, to tell whether they changed since a run. */
export const fingerprint = (/** @type {Settings} */ s) => createHash('sha1').update(JSON.stringify(s)).digest('hex').slice(0, 16);

/**
 * What to save for a set of settings: the OptionSettings fields and the options part of TradeDefaults.
 * @param {Settings} s
 * @param {any[]} otherCombos  saved combinations for other indexes, kept as they are
 */
export function savePatch(s, otherCombos = []) {
  const stop = s.stopRule;
  return {
    options: {
      combos: normalizeCombos([...s.combos, ...otherCombos]),
      patternEntries: s.patternEntries,
      patterns: s.patterns,
      maxTrades: s.maxTrades,
      dailyLossPct: s.dailyLossPct,
      lossStreak: s.lossStreak,
      patternStopMode: stop.mode,
      ...(stop.mode === 'atr' || stop.mode === 'cap' ? { patternStopAtr: stop.k } : {}),
      ...(stop.mode === 'fixed' ? { patternStopPoints: stop.points } : {}),
      trailMode: s.trail ? 'points' : 'off',
      ...(s.trail ? { trailPoints: s.trail.points, trailStart: s.trail.start } : {}),
      breakEvenPoints: s.breakEven,
      entryFrom: s.entryFrom,
      entryTo: s.entryTo,
    },
    rules: { stopLoss: s.lossLimit, steps: s.steps, lockOn: s.steps.length > 0 },
  };
}

/** A combination with the learner's parts (side, extra indicators, own exits) put in; null or empty parts are taken away. */
export function withParts(/** @type {any} */ c, /** @type {any} */ p) {
  const { side: _s, also: _a, exits: _e, ...rest } = c;
  return { ...rest, ...(p.side ? { side: p.side } : {}), ...(p.also?.length ? { also: p.also } : {}), ...(p.exits && Object.keys(p.exits).length ? { exits: p.exits } : {}) };
}

/** Each combination's last result for the screen, with whether it still matches the saved combination. */
function comboView(/** @type {any} */ combos, /** @type {Settings} */ settings) {
  if (!combos) return null;
  const list = (combos.list ?? []).map((/** @type {any} */ r) => {
    const now = settings.combos.find((c) => c.id === r.id);
    const stale = !now || (r.base && fingerprint(/** @type {any} */ (strip(now))) !== r.base && !(r.applied && !r.undone));
    return { ...r, stale: Boolean(stale), gone: !now, canUndo: Boolean(r.applied && !r.undone) };
  });
  return { ...combos, list };
}

export class LearnService {
  /** @param {{ lab: any, market: any, study?: any, config?: any, now?: () => Date, searchMs?: number }} o */
  constructor({ lab, market, study = null, config = {}, now = () => new Date(), searchMs = SEARCH_MS }) {
    this.lab = lab;
    this.study = study;
    this.searchMs = searchMs;
    this.market = market;
    this.config = config;
    this.now = now;
    /** @type {Map<string, { state: string, step: string, startedAt: number, done?: Promise<any> }>} */
    this.jobs = new Map();
  }

  status(/** @type {string} */ userId) {
    return this.jobs.get(String(userId)) || { state: 'idle', step: '' };
  }

  async #current(/** @type {string} */ userId) {
    const [s, d] = await Promise.all([OptionSettings.findOne({ user: userId }).lean(), TradeDefaults.findOne({ user: userId }).lean()]);
    return { raw: s, settings: settingsOf(s, d), budget: s?.budget ?? 60000 };
  }

  async #state(/** @type {string} */ userId) {
    return (await LearnerState.findOne({ user: userId, kind: KIND })) || new LearnerState({ user: userId, kind: KIND });
  }

  /** The card: the job, the last result (without the full settings objects), whether it still matches the saved settings, the log. */
  async view(/** @type {string} */ userId) {
    const [st, cur] = await Promise.all([LearnerState.findOne({ user: userId, kind: KIND }).lean(), this.#current(userId)]);
    const last = /** @type {any} */ (st?.last) ?? null;
    const { proposal, current, ...shown } = last ?? {};
    const status = this.status(userId);
    // a run that started but never finished: the server restarted (or crashed) while it ran
    const interrupted = status.state !== 'running' && st?.log?.[0]?.action === 'started';
    return {
      status: status.state === 'running' ? { ...status, seconds: Math.round((Date.now() - /** @type {any} */ (status).startedAt) / 1000) } : status,
      interrupted: interrupted ? 'The last run did not finish: the server stopped while it was learning (an update or a restart does that). Tap Learn now again and keep the app server running until it is done.' : null,
      last: last ? { ...shown, stale: last.base !== fingerprint(cur.settings) && !last.applied, canUndo: Boolean(last.applied && !last.undone) } : null,
      log: st?.log ?? [],
      combos: comboView(/** @type {any} */ (st)?.combos, cur.settings),
      shares: await this.#sharesView(userId, /** @type {any} */ (st)?.shares),
      track: /** @type {any} */ (st)?.track ?? [],
      evening: Boolean(/** @type {any} */ (st)?.evening),
      simulated: Boolean(this.market?.provider?.isSimulated),
      days: LEARN_DAYS,
    };
  }

  /** Switches the evening run on or off: each trading evening it learns the whole setup and each combination. It never applies anything. */
  async setEvening(/** @type {string} */ userId, /** @type {boolean} */ on) {
    await LearnerState.updateOne({ user: userId, kind: KIND }, { $set: { evening: Boolean(on) }, $setOnInsert: { user: userId, kind: KIND } }, { upsert: true });
    return this.view(userId);
  }

  /** One check of the evening schedule: on a trading day after EVENING_AFTER_MIN, each user with the evening run on, once a day. */
  async tick() {
    if (this.market?.provider?.isSimulated) return; // made-up candles: nothing to learn
    const now = this.now();
    const { minutes, dateKey } = istParts(now);
    if (!isTradingDay(now, this.config.nseHolidays ?? []) || minutes < EVENING_AFTER_MIN) return;
    for (const st of await LearnerState.find({ kind: KIND, evening: true, eveningDay: { $ne: dateKey } }, 'user').lean()) {
      const userId = String(st.user);
      if (this.status(userId).state === 'running') continue;
      await LearnerState.updateOne({ _id: st._id }, { $set: { eveningDay: dateKey } });
      for (const what of WHAT) {
        if (what === 'shares' && !this.study) continue;
        try {
          await /** @type {any} */ (this.start(userId, { days: 30, what, by: 'evening' })).done;
        } catch (e) {
          logger.warn(`evening learn (${what}) failed: ${/** @type {any} */ (e).message}`);
        }
      }
    }
  }

  schedule() {
    const run = () => this.tick().catch((e) => logger.warn(`learn schedule failed: ${e.message}`));
    this.timer = setInterval(run, EVENING_TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Learn > Each combination: every Nifty combination (switched-on ones first) tuned on its own. Nothing is applied. */
  async #runCombos(/** @type {string} */ userId, /** @type {any} */ job, /** @type {number} */ days) {
    const cur = await this.#current(userId);
    const { ctx, useDays, real, notes } = await this.#prepare(userId, job, days, cur);
    const st = await this.#state(userId);
    const before = /** @type {any[]} */ (st.combos?.list ?? []);
    const list = [...cur.settings.combos].sort((a, b) => Number(b.on !== false) - Number(a.on !== false)).slice(0, MAX_TUNED);
    const started = Date.now();
    const results = [];
    for (const [n, combo] of list.entries()) {
      job.step = `Combination ${n + 1} of ${list.length}: ${combo.name}`;
      const share = (COMBO_SEARCH_MS * this.searchMs) / SEARCH_MS / list.length; // tests shorten searchMs, and this with it
      const old = before.find((r) => r.id === combo.id);
      const previous = old?.proposal && ['passed', 'thin'].includes(old.verdict) ? { ...combo, ...old.proposal, also: old.proposal.also?.length ? old.proposal.also : undefined, side: old.proposal.side ?? undefined, exits: old.proposal.exits ?? undefined } : null;
      const r = /** @type {any} */ (await tuneCombo({
        combo,
        base: cur.settings,
        days: useDays,
        evaluate: ctx.evaluate,
        dayOf: (t) => dayKey(t.entryTime),
        labelOf: (k) => CONDITION_BY_KEY.get(k)?.label ?? k,
        usable: ctx.usable,
        deadline: Math.min(started + COMBO_SEARCH_MS * (this.searchMs / SEARCH_MS), Date.now() + share),
        previous,
      }));
      // how many runs in a row it suggested the same thing and passed: a pick that keeps passing on new days is worth more than one lucky run
      const same = old && JSON.stringify(old.proposal) === JSON.stringify(r.proposal);
      r.streak = r.verdict === 'passed' ? (same && old.verdict === 'passed' ? (old.streak ?? 1) + 1 : 1) : 0;
      r.base = fingerprint(/** @type {any} */ (strip(combo)));
      if (old?.applied && !old.undone && same) r.applied = old.applied;
      results.push(r);
      await new Promise((resolve) => setImmediate(resolve));
    }
    job.step = 'Checking earlier applied results on the days since';
    await this.#trackRecord(st, ctx, useDays, cur);
    st.combos = { at: this.now().toISOString(), day: istParts(this.now()).dateKey, daysAsked: days, pricing: real ? 'real' : 'estimated', notes, by: job.by ?? 'you', list: results };
    st.markModified('combos');
    const passed = results.filter((r) => r.verdict === 'passed');
    const text = passed.length ? `${passed.length} of ${results.length} combinations have better settings that passed the hidden days: ${passed.map((r) => r.name).join(', ')}.` : `No combination got settings that passed the hidden days (${results.length} tried).`;
    st.log = [{ at: st.combos.at, action: 'learned combos', seconds: Math.round((Date.now() - job.startedAt) / 1000), verdict: passed.length ? 'passed' : 'same', text }, ...st.log].slice(0, LOG_MAX);
    st.markModified('log');
    await st.save();
    logger.info(`lab learn combos: ${passed.length}/${results.length} passed, ${Math.round((Date.now() - job.startedAt) / 1000)} s`);
    return st.combos;
  }

  async #sharesView(/** @type {string} */ userId, /** @type {any} */ shares) {
    if (!shares) return null;
    const { proposal, current, ...shown } = shares;
    const auto = await AutoSettings.findOne({ user: userId }).lean();
    const stale = Boolean(shares.base && fingerprint(/** @type {any} */ (shareSettingsOf(auto))) !== shares.base && !(shares.applied && !shares.undone));
    return { ...shown, stale, canUndo: Boolean(shares.applied && !shares.undone) };
  }

  /** Learn > Shares: the scanner replayed as live on the saved days, then the share settings tuned on those ideas. Nothing is applied. */
  async #runShares(/** @type {string} */ userId, /** @type {any} */ job) {
    job.step = 'Replaying the scanner on the 50 stocks';
    const { ideas, opts, auto, stocks } = await this.study.liveShareIdeas(userId, { days: SHARE_DAYS, onStep: (/** @type {string} */ step) => { job.step = step; } });
    const current = shareSettingsOf(auto);
    const st = await this.#state(userId);
    const hints = (st.shares?.verdict === 'passed' ? st.shares.changes ?? [] : []).map((/** @type {any} */ c) => c.label);
    job.step = 'Trying share settings';
    const result = /** @type {any} */ (await tuneShares({ ideas, current, opts, deadline: Date.now() + SHARE_SEARCH_MS * (this.searchMs / SEARCH_MS), hints }));
    // how the share settings you applied did on the days since
    const track = [...(st.track ?? [])];
    for (const it of st.applied ?? []) {
      if (it.kind !== 'shares' || it.undone) continue;
      const after = [...new Set(ideas.map((i) => String(i.openedAt).slice(0, 10)))].filter((d) => d > it.appliedOn).sort();
      if (!after.length) continue;
      const dayOf = (/** @type {any} */ t) => t.day;
      const row = { key: it.key, kind: 'shares', name: it.name, appliedOn: it.appliedOn, forced: Boolean(it.forced), days: after.length, to: after.at(-1), old: steady(shareTrades(ideas, it.old, opts), after, dayOf), new: steady(shareTrades(ideas, it.neu, opts), after, dayOf) };
      const at = track.findIndex((t) => t.key === it.key);
      if (at >= 0) track[at] = row;
      else track.unshift(row);
    }
    st.track = track.slice(0, TRACK_MAX);
    st.markModified('track');
    const notes = ['The minimum score is not tried: replayed scores run lower than live ones. The daily loss limit and stop-after-losses are kept as they are.', 'The replay has no order book and skips the scanner limit on open ideas, so live results differ a little.'];
    if (this.market?.provider?.isSimulated) notes.push('The sample feed is on: these candles are made up, so the result means nothing for real trading.');
    const same = st.shares?.proposal && JSON.stringify(st.shares.proposal) === JSON.stringify(result.proposal);
    st.shares = { ...result, at: this.now().toISOString(), day: istParts(this.now()).dateKey, stocks, notes, by: job.by ?? 'you', base: fingerprint(/** @type {any} */ (current)), current, streak: result.verdict === 'passed' ? (same && st.shares?.verdict === 'passed' ? (st.shares.streak ?? 1) + 1 : 1) : 0 };
    st.markModified('shares');
    st.log = [{ at: st.shares.at, action: 'learned shares', seconds: Math.round((Date.now() - job.startedAt) / 1000), verdict: result.verdict, text: result.text }, ...st.log].slice(0, LOG_MAX);
    st.markModified('log');
    await st.save();
    return st.shares;
  }

  /** Puts the learned share settings in place (entry hours, setups, entry rules, exit). A failed result needs `force`. */
  async applyShares(/** @type {string} */ userId, { force = false } = {}) {
    const st = await this.#state(userId);
    const r = /** @type {any} */ (st.shares);
    if (!r?.proposal || !r.changes?.length) throw badRequest('There is nothing to apply. Run Learn for shares first.');
    if (r.applied && !r.undone) throw conflict('Already applied.');
    if (r.verdict !== 'passed' && !force) throw conflict('This did not pass the hidden days, so Apply is blocked. Use Apply anyway if you still want it.');
    const auto = await AutoSettings.findOne({ user: userId }).lean();
    if (fingerprint(/** @type {any} */ (shareSettingsOf(auto))) !== r.base) throw conflict('Your share settings changed after this run. Run Learn again.');
    await AutoSettings.updateOne({ user: userId }, { $set: sharePatch(r.proposal) }, { runValidators: true });
    const now = this.now();
    r.applied = { at: now.toISOString(), day: istParts(now).dateKey, forced: r.verdict !== 'passed' };
    delete r.undone;
    st.applied = [{ key: `shares:${r.applied.at}`, kind: 'shares', name: `Shares (${r.changes.length} change${r.changes.length === 1 ? '' : 's'})`, appliedOn: r.applied.day, forced: r.applied.forced, old: r.current, neu: r.proposal }, ...(st.applied ?? [])].slice(0, TRACK_MAX);
    st.log = [{ at: r.applied.at, action: r.applied.forced ? 'applied anyway' : 'applied', text: `Shares: ${r.changes.map((/** @type {any} */ c) => c.label).join(', ')}.` }, ...st.log].slice(0, LOG_MAX);
    for (const k of ['shares', 'applied', 'log']) st.markModified(k);
    await st.save();
    return this.view(userId);
  }

  /** Puts the share settings back as they were before the apply. */
  async undoShares(/** @type {string} */ userId) {
    const st = await this.#state(userId);
    const r = /** @type {any} */ (st.shares);
    if (!r?.applied || r.undone) throw badRequest('Nothing to undo for shares.');
    await AutoSettings.updateOne({ user: userId }, { $set: sharePatch(r.current) }, { runValidators: true });
    r.undone = { at: this.now().toISOString() };
    st.applied = (st.applied ?? []).map((/** @type {any} */ it) => (it.key === `shares:${r.applied.at}` ? { ...it, undone: true } : it));
    st.log = [{ at: r.undone.at, action: 'undone', text: 'Shares: your settings from before are back.' }, ...st.log].slice(0, LOG_MAX);
    for (const k of ['shares', 'applied', 'log']) st.markModified(k);
    await st.save();
    return this.view(userId);
  }

  /** Puts one combination's suggested settings (side, extra indicators, own exits) in place. A failed or thin result needs `force`. */
  async applyCombo(/** @type {string} */ userId, /** @type {string} */ id, { force = false } = {}) {
    const st = await this.#state(userId);
    const r = /** @type {any} */ (st.combos?.list ?? []).find((/** @type {any} */ x) => x.id === id);
    if (!r?.proposal || !r.changes?.length) throw badRequest('There is nothing to apply for this combination. Run Learn first.');
    if (r.applied && !r.undone) throw conflict('Already applied.');
    if (r.verdict !== 'passed' && !force) throw conflict('This did not pass the hidden days, so Apply is blocked. Use Apply anyway if you still want it.');
    const raw = await OptionSettings.findOne({ user: userId });
    const list = normalizeCombos(raw?.combos ?? []);
    const at = list.findIndex((c) => c.id === id);
    if (at < 0) throw badRequest('That combination is no longer saved.');
    if (fingerprint(/** @type {any} */ (strip(list[at]))) !== r.base) throw conflict('This combination was changed after the run. Run Learn again.');
    const prev = strip(list[at]);
    list[at] = withParts(list[at], r.proposal);
    await OptionSettings.updateOne({ user: userId }, { $set: { combos: normalizeCombos(list) } }, { runValidators: true });
    const now = this.now();
    r.applied = { at: now.toISOString(), day: istParts(now).dateKey, forced: r.verdict !== 'passed', prev };
    delete r.undone;
    st.applied = [{ key: `combo:${id}:${r.applied.at}`, kind: 'combo', id, name: r.name, appliedOn: r.applied.day, forced: r.applied.forced, old: prev, neu: r.proposal }, ...(st.applied ?? [])].slice(0, TRACK_MAX);
    st.log = [{ at: r.applied.at, action: r.applied.forced ? 'applied anyway' : 'applied', text: `${r.name}: ${r.changes.map((/** @type {any} */ c) => c.label).join(', ')}.` }, ...st.log].slice(0, LOG_MAX);
    for (const k of ['combos', 'applied', 'log']) st.markModified(k);
    await st.save();
    return this.view(userId);
  }

  /** Puts one combination back as it was before its apply. */
  async undoCombo(/** @type {string} */ userId, /** @type {string} */ id) {
    const st = await this.#state(userId);
    const r = /** @type {any} */ (st.combos?.list ?? []).find((/** @type {any} */ x) => x.id === id);
    if (!r?.applied || r.undone) throw badRequest('Nothing to undo for this combination.');
    const raw = await OptionSettings.findOne({ user: userId });
    const list = normalizeCombos(raw?.combos ?? []);
    const at = list.findIndex((c) => c.id === id);
    if (at >= 0) {
      list[at] = withParts(list[at], r.applied.prev);
      await OptionSettings.updateOne({ user: userId }, { $set: { combos: normalizeCombos(list) } }, { runValidators: true });
    }
    r.undone = { at: this.now().toISOString() };
    st.applied = (st.applied ?? []).map((/** @type {any} */ it) => (it.key === `combo:${id}:${r.applied.at}` ? { ...it, undone: true } : it));
    st.log = [{ at: r.undone.at, action: 'undone', text: `${r.name}: put back as it was.` }, ...st.log].slice(0, LOG_MAX);
    for (const k of ['combos', 'applied', 'log']) st.markModified(k);
    await st.save();
    return this.view(userId);
  }

  /** Starts a run in the background; poll view(). */
  start(/** @type {string} */ userId, { days = 30, what = 'setup', by = 'you' } = {}) {
    if (!LEARN_DAYS.includes(days)) throw badRequest(`Pick ${LEARN_DAYS.join(', ')} days`);
    if (!WHAT.includes(what)) throw badRequest('Pick the whole setup, each combination or shares');
    if (what === 'shares' && !this.study) throw badRequest('Learn for shares is not available on this server.');
    if (this.status(userId).state === 'running') throw conflict('Learn is already running');
    const job = { state: 'running', step: 'Starting', startedAt: Date.now(), what, by };
    this.jobs.set(String(userId), job);
    const words = what === 'combos' ? 'each combination' : what === 'shares' ? 'shares' : 'the whole setup';
    /** @type {any} */ (job).done = this.#mark(userId, { at: this.now().toISOString(), action: 'started', text: `Started on ${days} days: ${words}${by === 'evening' ? ' (evening run)' : ''}.` })
      .then(() => (what === 'combos' ? this.#runCombos(userId, job, days) : what === 'shares' ? this.#runShares(userId, job) : this.#run(userId, job, days)))
      .catch(async (e) => {
        logger.warn(`lab learn failed: ${e.stack || e.message}`);
        const st = await this.#state(userId);
        const at = this.now().toISOString();
        if (what === 'combos' || what === 'shares') {
          st[what] = { ...(st[what] ?? {}), error: `Learn could not run: ${e.message}`, errorAt: at };
          st.markModified(what);
        } else st.last = { at, verdict: 'error', text: `Learn could not run: ${e.message}` };
        st.log = [{ at, action: 'failed', text: e.message }, ...st.log].slice(0, LOG_MAX);
        st.markModified('log');
        await st.save();
      })
      .catch((e) => logger.warn(`lab learn could not save its error: ${e.message}`))
      .finally(() => this.jobs.delete(String(userId)));
    return job;
  }

  async #mark(/** @type {string} */ userId, /** @type {any} */ entry) {
    const st = await this.#state(userId);
    st.log = [entry, ...st.log].slice(0, LOG_MAX);
    st.markModified('log');
    await st.save();
  }

  /** The saved days and the replay for a run: real premiums when enough are saved, otherwise the model's. */
  async #prepare(/** @type {string} */ userId, /** @type {any} */ job, /** @type {number} */ days, /** @type {any} */ cur) {
    job.step = 'Reading the saved option prices';
    const book = await this.lab.priceBook(INDEX);
    const now = this.now();
    const real = book.days.length >= MIN_DAYS;
    const firstUsed = real ? book.days.slice(-days)[0] : null;
    const calendar = (firstUsed ? Math.ceil((now.getTime() - Date.parse(`${firstUsed}T00:00:00Z`)) / 86400000) + 1 : Math.ceil((days * 7) / 5)) + WARMUP_DAYS;
    job.step = 'Reading the saved candles';
    const { nifty1, stocks5 } = await this.lab.optionsData(INDEX, calendar);
    const params = await this.lab.optionParams(userId, INDEX);
    const candleDays = [...new Set(nifty1.map((/** @type {any} */ b) => dayKey(b.time)))].sort();
    // with enough saved real premiums only those days are used (an entry whose contract was not saved is skipped, as in the study);
    // otherwise the candle days with premiums estimated by the model, and real ones where saved
    const useDays = real ? book.days.filter((d) => candleDays.includes(d)).slice(-days) : candleDays.slice(-days);
    if (book.days.length) {
      params.prices = book;
      params.mixPrices = !real;
    }
    // as live and as Replay: your indicator-score entries, your minimum chart score, and the Replay test's fill (0.5% worse each way)
    params.scoreEntries = cur.raw?.scoreEntries === true;
    params.scoreMin = cur.raw?.minScore ?? 70;
    params.comboMinScore = cur.raw?.comboMinScore ?? 0;
    params.patternMinScore = cur.raw?.patternMinScore ?? 0;
    params.slippage = FILL_SLIPPAGE;
    job.step = 'Building the chart';
    const ctx = learnContext({ nifty1, stocks5, book: book.days.length ? book : null, params, days: useDays, budget: cur.budget });
    if (params.scoreEntries || params.comboMinScore > 0 || params.patternMinScore > 0) {
      job.step = 'Working out the chart score at each 5-minute close';
      await ctx.warm();
    }
    const notes = [];
    if (!real) notes.push(book.days.length ? `Only ${book.days.length} days of real option prices are saved, so the other days use the model's estimated premiums.` : 'No real option prices are saved yet, so every premium is the model\'s estimate and the options checks (PCR, IV, OI, max pain, delta, theta) cannot be tried.');
    if (params.scoreEntries) notes.push(`Your indicator-score entries (score ${params.scoreMin}+) are traded here as live. Each combination on its own is tuned without them.`);
    if (params.comboMinScore > 0 || params.patternMinScore > 0) notes.push('Your minimum chart score on entries is checked here as live.');
    notes.push('Every fill is 0.5% worse than the price seen, as in Replay test. These are still estimates: check the best ideas in Replay test before using them.');
    if (this.market?.provider?.isSimulated) notes.push('The sample feed is on: these candles are made up, so the result means nothing for real trading.');
    return { ctx, useDays, real, notes };
  }

  /**
   * How the applied results (st.applied) did on the days after they were applied: the settings from before against the applied ones, replayed on
   * those later days only (never seen when the result was learned). This is the test that says whether the learner's picks hold up.
   */
  async #trackRecord(/** @type {any} */ st, /** @type {any} */ ctx, /** @type {string[]} */ useDays, /** @type {any} */ cur) {
    const dayOf = (/** @type {any} */ t) => dayKey(t.entryTime);
    const items = [];
    for (const it of st.applied ?? []) {
      if (it.undone) continue;
      if (it.kind === 'setup') items.push({ ...it, oldS: it.old, newS: it.neu });
      else {
        const now = cur.settings.combos.find((/** @type {any} */ x) => x.id === it.id);
        if (!now) continue;
        const alone = (/** @type {any} */ parts) => ({ ...cur.settings, patternEntries: false, scoreEntries: false, combos: [{ ...now, ...parts, on: true }] });
        items.push({ ...it, oldS: alone(it.old), newS: alone(it.neu) });
      }
    }
    const track = [...(st.track ?? [])];
    for (const it of items) {
      const after = useDays.filter((d) => d > it.appliedOn);
      if (!after.length) continue;
      const [oldT, newT] = [await ctx.evaluate(it.oldS), await ctx.evaluate(it.newS)];
      const row = { key: it.key, kind: it.kind, name: it.name, appliedOn: it.appliedOn, forced: Boolean(it.forced), days: after.length, to: after.at(-1), old: steady(oldT, after, dayOf), new: steady(newT, after, dayOf) };
      const at = track.findIndex((t) => t.key === it.key);
      if (at >= 0) track[at] = row;
      else track.unshift(row);
    }
    st.track = track.slice(0, TRACK_MAX);
    st.markModified('track');
  }

  async #run(/** @type {string} */ userId, /** @type {any} */ job, /** @type {number} */ days) {
    const cur = await this.#current(userId);
    const { ctx, useDays, real, notes } = await this.#prepare(userId, job, days, cur);
    const before = await this.#state(userId);
    // the changes that passed in earlier runs are tried first, so each run starts from what already worked
    const hints = [...new Set((before.log ?? []).filter((/** @type {any} */ e) => e.action === 'learned' && e.verdict === 'passed').flatMap((/** @type {any} */ e) => e.labels ?? []))];
    const otherCombos = normalizeCombos(cur.raw?.combos ?? []).filter((c) => c.index && c.index !== INDEX);
    const result = await tune({
      days: useDays,
      current: cur.settings,
      evaluate: ctx.evaluate,
      dayOf: (t) => dayKey(t.entryTime),
      labelOf: (k) => CONDITION_BY_KEY.get(k)?.label ?? k,
      usable: ctx.usable,
      patterns: LIVE_PATTERNS,
      maxCombos: MAX_COMBOS - otherCombos.length,
      onProgress: (step) => {
        job.step = step;
      },
      deadline: Date.now() + this.searchMs,
      hints,
    });
    logger.info(`lab learn: ${result.verdict} on ${useDays.length} days, ${result.tried} tried, ${Math.round((Date.now() - job.startedAt) / 1000)} s`);
    if (/** @type {any} */ (result).stoppedEarly) notes.unshift(`It stopped trying new changes after ${Math.round(this.searchMs / 60000)} minutes to stay quick, and judged what it had found by then.`);
    if (/** @type {any} */ (result).uneven) notes.push(`${/** @type {any} */ (result).uneven} change${/** @type {any} */ (result).uneven === 1 ? ' was' : 's were'} left out because they only helped on some of the learning days (likely luck).`);
    const st = await this.#state(userId);
    job.step = 'Checking earlier applied results on the days since';
    await this.#trackRecord(st, ctx, useDays, cur);
    st.last = {
      ...result,
      at: this.now().toISOString(),
      day: istParts(this.now()).dateKey,
      daysAsked: days,
      pricing: real ? 'real' : 'estimated',
      optionDays: ctx.optionDays,
      notes,
      by: job.by ?? 'you',
      base: fingerprint(cur.settings),
      current: cur.settings,
      proposal: /** @type {any} */ (result).proposal ?? null,
    };
    st.log = [{ at: st.last.at, action: 'learned', seconds: Math.round((Date.now() - job.startedAt) / 1000), verdict: result.verdict, text: result.text, changes: result.changes?.length ?? 0, labels: (result.changes ?? []).map((c) => c.label) }, ...st.log].slice(0, LOG_MAX);
    st.markModified('log');
    await st.save();
    return st.last;
  }

  /** Apply the last result. `force` is needed when it failed on the hidden days ("Apply anyway", confirmed on the screen). */
  async apply(/** @type {string} */ userId, { force = false } = {}) {
    const st = await this.#state(userId);
    const last = /** @type {any} */ (st.last);
    if (!last?.proposal || !['passed', 'failed'].includes(last.verdict)) throw badRequest('There is nothing to apply. Run Learn first.');
    if (last.applied) throw conflict('This result is already applied.');
    if (last.verdict === 'failed' && !force) throw conflict('These settings failed on the hidden days, so Apply is blocked. Use Apply anyway if you still want them.');
    const cur = await this.#current(userId);
    if (fingerprint(cur.settings) !== last.base) throw conflict('Your settings changed after this run. Run Learn again so it learns from what you have now.');
    await this.#save(userId, last.proposal, cur.raw);
    last.applied = { at: this.now().toISOString(), day: istParts(this.now()).dateKey, forced: last.verdict === 'failed' };
    st.applied = [{ key: `setup:${last.applied.at}`, kind: 'setup', name: `Whole setup (${last.changes.length} change${last.changes.length === 1 ? '' : 's'})`, appliedOn: last.applied.day, forced: last.applied.forced, old: last.current, neu: last.proposal }, ...(st.applied ?? [])].slice(0, TRACK_MAX);
    st.markModified('applied');
    st.last = { ...last };
    st.log = [{ at: last.applied.at, action: last.applied.forced ? 'applied anyway' : 'applied', verdict: last.verdict, text: `${last.changes.length} change${last.changes.length === 1 ? '' : 's'} applied${last.applied.forced ? ' although it failed on the hidden days' : ''}.` }, ...st.log].slice(0, LOG_MAX);
    st.markModified('last');
    st.markModified('log');
    await st.save();
    return this.view(userId);
  }

  /** Put back the settings that were there before the last apply. */
  async undo(/** @type {string} */ userId) {
    const st = await this.#state(userId);
    const last = /** @type {any} */ (st.last);
    if (!last?.applied || last.undone) throw badRequest('There is no applied result to undo.');
    const cur = await this.#current(userId);
    await this.#save(userId, last.current, cur.raw);
    last.undone = { at: this.now().toISOString() };
    st.applied = (st.applied ?? []).map((/** @type {any} */ it) => (it.key === `setup:${last.applied.at}` ? { ...it, undone: true } : it));
    st.markModified('applied');
    st.last = { ...last };
    st.log = [{ at: last.undone.at, action: 'undone', text: 'Your settings from before the apply are back.' }, ...st.log].slice(0, LOG_MAX);
    st.markModified('last');
    st.markModified('log');
    await st.save();
    return this.view(userId);
  }

  async #save(/** @type {string} */ userId, /** @type {Settings} */ s, /** @type {any} */ raw) {
    const others = normalizeCombos(raw?.combos ?? []).filter((c) => c.index && c.index !== INDEX);
    const patch = savePatch(s, others);
    await OptionSettings.findOneAndUpdate({ user: userId }, { $set: patch.options, $setOnInsert: { user: userId } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    await TradeDefaults.findOneAndUpdate({ user: userId }, { $set: { 'options.stopLoss': patch.rules.stopLoss, 'options.steps': patch.rules.steps, 'options.lockOn': patch.rules.lockOn }, $setOnInsert: { user: userId } }, { upsert: true, new: true, runValidators: true });
  }
}
