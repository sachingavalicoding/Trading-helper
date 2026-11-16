// @ts-check
import { createHash } from 'node:crypto';
import { LearnerState, OptionSettings, TradeDefaults } from '../models/index.js';
import { rulesFor } from '../models/TradeDefaults.js';
import { normalizeCombos, MAX_COMBOS } from '../combos/combos.js';
import { CONDITION_BY_KEY } from '../combos/conditions.js';
import { stopRuleOf } from '../study/patterns.js';
import { trailOf, breakEvenOf } from '../study/simulate.js';
import { entryWindowOf } from '../options/signal.js';
import { LIVE_PATTERNS, DEFAULT_PATTERNS } from '../options/optionTrader.js';
import { istParts } from '../market/marketHours.js';
import { badRequest, conflict } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { tune, MIN_DAYS } from './tune.js';
import { learnContext, dayKey } from './learnRun.js';

// Lab > Learn: runs the settings learner (tune.js) for a user in the background, keeps the last result, and applies it to the paper
// options settings on request. A result that failed on the hidden days is applied only with `force` (the screen asks first), and only
// while the settings are still the ones it learned from. Undo puts back what was there before the last apply.

/** @typedef {import('./tune.js').Settings} Settings */

export const KIND = 'tune';
export const LEARN_DAYS = [15, 20, 30];
const INDEX = 'NIFTY';
const WARMUP_DAYS = 6;
const LOG_MAX = 30;

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

export class LearnService {
  /** @param {{ lab: any, market: any, config?: any, now?: () => Date }} o */
  constructor({ lab, market, config = {}, now = () => new Date() }) {
    this.lab = lab;
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
    return {
      status: this.status(userId),
      last: last ? { ...shown, stale: last.base !== fingerprint(cur.settings) && !last.applied, canUndo: Boolean(last.applied && !last.undone) } : null,
      log: st?.log ?? [],
      simulated: Boolean(this.market?.provider?.isSimulated),
      days: LEARN_DAYS,
    };
  }

  /** Starts a run in the background; poll view(). */
  start(/** @type {string} */ userId, { days = 30 } = {}) {
    if (!LEARN_DAYS.includes(days)) throw badRequest(`Pick ${LEARN_DAYS.join(', ')} days`);
    if (this.status(userId).state === 'running') throw conflict('Learn is already running');
    const job = { state: 'running', step: 'Starting', startedAt: Date.now() };
    this.jobs.set(String(userId), job);
    /** @type {any} */ (job).done = this.#run(userId, job, days)
      .catch(async (e) => {
        logger.warn(`lab learn failed: ${e.message}`);
        const st = await this.#state(userId);
        st.last = { at: this.now().toISOString(), verdict: 'error', text: `Learn could not run: ${e.message}` };
        await st.save();
      })
      .finally(() => this.jobs.delete(String(userId)));
    return job;
  }

  async #run(/** @type {string} */ userId, /** @type {any} */ job, /** @type {number} */ days) {
    const cur = await this.#current(userId);
    job.step = 'Reading the saved option prices';
    const book = await this.lab.priceBook(INDEX);
    const real = book.days.length >= MIN_DAYS;
    const firstUsed = real ? book.days.slice(-days)[0] : null;
    const calendar = (firstUsed ? Math.ceil((this.now().getTime() - Date.parse(`${firstUsed}T00:00:00Z`)) / 86400000) + 1 : Math.ceil((days * 7) / 5)) + WARMUP_DAYS;
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
    job.step = 'Building the chart';
    const ctx = learnContext({ nifty1, stocks5, book: book.days.length ? book : null, params, days: useDays, budget: cur.budget });
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
    });
    const notes = [];
    if (!real) notes.push(book.days.length ? `Only ${book.days.length} days of real option prices are saved, so the other days use the model's estimated premiums.` : 'No real option prices are saved yet, so every premium is the model\'s estimate and the options checks (PCR, IV, OI, max pain, delta, theta) cannot be tried.');
    if (cur.raw?.scoreEntries) notes.push('Your indicator-score entries are not replayed here; only combinations and patterns are.');
    if ((cur.raw?.comboMinScore ?? 0) > 0 || (cur.raw?.patternMinScore ?? 0) > 0) notes.push('The minimum chart score on entries is not replayed here.');
    if (this.market?.provider?.isSimulated) notes.push('The sample feed is on: these candles are made up, so the result means nothing for real trading.');
    const st = await this.#state(userId);
    st.last = {
      ...result,
      at: this.now().toISOString(),
      day: istParts(this.now()).dateKey,
      daysAsked: days,
      pricing: real ? 'real' : 'estimated',
      optionDays: ctx.optionDays,
      notes,
      base: fingerprint(cur.settings),
      current: cur.settings,
      proposal: /** @type {any} */ (result).proposal ?? null,
    };
    st.log = [{ at: st.last.at, action: 'learned', verdict: result.verdict, text: result.text, changes: result.changes?.length ?? 0 }, ...st.log].slice(0, LOG_MAX);
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
    last.applied = { at: this.now().toISOString(), forced: last.verdict === 'failed' };
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
