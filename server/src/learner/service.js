import { LearnerState, OptionSettings, AutoSettings, AutoLog, OptionCandleDay } from '../models/index.js';
import { normalizeCombos, MAX_COMBOS } from '../combos/combos.js';
import { istParts, isTradingDay } from '../market/marketHours.js';
import { conflict, badRequest } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { learn, LEARNER_SLOT, slotCombo } from './learn.js';

// The auto-learner: once each trading evening (after the day's candles and option prices are saved) and whenever asked, it re-runs the
// finders on the saved days, picks the best combination on the older days, and keeps it only if it also made money on the newest days it never
// saw and beat the current combinations there (learn.js). With "auto" on it puts that pick in the one slot it owns in the saved combinations
// (paper trading only, like everything in this app); with it off it only suggests. Undo takes the slot out and turns auto off.

export const KINDS = ['options', 'shares'];
export const LEARN_DAYS = { options: 30, shares: 15 };
export const RUN_AFTER_MIN = 16 * 60 + 30; // 16:30 IST: the evening top-up of candles (15:40) and option prices is done by then
export const MIN_REAL_DAYS = 15; // fewer days of saved real option prices than this: the learner uses the model's estimated premiums over 30 days
export const BENCH_AFTER = 3; // shares: the learner's combination is switched off after this many live losses in a row (options use Account > Limits)
const LOG_MAX = 60;
const CHANGES = ['added', 'replaced', 'used'];
const ENDS = [...CHANGES, 'undone', 'paused', 'benched'];
const TICK_MS = 5 * 60 * 1000;

const modelOf = (kind) => (kind === 'shares' ? AutoSettings : OptionSettings);
const segmentOf = (kind) => (kind === 'shares' ? { $ne: 'OPT' } : 'OPT');
const sameCombo = (a, b) => Boolean(a && b) && [...a.conds].sort().join('+') === [...b.conds].sort().join('+') && (a.side ?? null) === (b.side ?? null);
const brief = (p) => (p ? { name: p.name, conds: p.conds, labels: p.labels, side: p.side ?? null, sideText: p.sideText, train: p.train, test: p.test } : {});

export class LearnerService {
  constructor({ study, market, config = {}, now = () => new Date() }) {
    this.study = study;
    this.market = market;
    this.config = config;
    this.now = now;
    this.jobs = new Map(); // `${userId}|${kind}` -> { state: 'running', step, startedAt }
    this.timer = null;
  }

  status(userId, kind) {
    return this.jobs.get(`${userId}|${kind}`) || { state: 'idle' };
  }

  async #state(userId, kind) {
    return (await LearnerState.findOne({ user: userId, kind })) || new LearnerState({ user: userId, kind });
  }

  async #settings(userId, kind) {
    const Model = modelOf(kind);
    return (await Model.findOne({ user: userId })) || new Model({ user: userId });
  }

  /** Everything the card shows: the switch, the last result, the learner's saved combination, and the log with how each change did live. */
  async view(userId, kind) {
    const [st, settings] = await Promise.all([LearnerState.findOne({ user: userId, kind }).lean(), modelOf(kind).findOne({ user: userId }).lean()]);
    const slot = normalizeCombos(settings?.combos).find((c) => c.id === LEARNER_SLOT) ?? null;
    const log = await this.liveResults(userId, kind, st?.log ?? []);
    const traderOff = kind === 'shares' ? !settings?.enabled : !settings?.enabled || settings?.comboEntries === false;
    return { kind, auto: Boolean(st?.auto), status: this.status(userId, kind), last: st?.last ?? null, slot, log, traderOff, simulated: Boolean(this.market?.provider?.isSimulated) };
  }

  /** Starts a run in the background (one per user and kind); poll view(). */
  start(userId, kind, { by = 'you' } = {}) {
    if (!KINDS.includes(kind)) throw badRequest('kind must be options or shares');
    if (this.status(userId, kind).state === 'running') throw conflict('The learner is already running');
    const job = { state: 'running', step: 'Starting', startedAt: Date.now() };
    this.jobs.set(`${userId}|${kind}`, job);
    const done = this.#run(userId, kind, job, by)
      .catch(async (e) => {
        logger.warn(`learner (${kind}) failed: ${e.message}`);
        const st = await this.#state(userId, kind);
        st.last = { at: this.now().toISOString(), day: istParts(this.now()).dateKey, verdict: 'failed', text: `The learner could not run: ${e.message}`, by };
        await st.save();
      })
      .finally(() => this.jobs.delete(`${userId}|${kind}`));
    job.done = done;
    return job;
  }

  async #run(userId, kind, job, by) {
    const settings = await modelOf(kind).findOne({ user: userId }).lean();
    const list = normalizeCombos(settings?.combos);
    const previous = list.find((c) => c.id === LEARNER_SLOT) ?? null;
    const current = list.filter((c) => c.on && c.id !== LEARNER_SLOT);
    let realPrices = true;
    if (kind === 'options') {
      job.step = 'Counting the saved option prices';
      realPrices = (await OptionCandleDay.distinct('day', { index: 'NIFTY' })).length >= MIN_REAL_DAYS;
    }
    const result = await this.study.learnRun(userId, kind, {
      days: LEARN_DAYS[kind],
      realPrices,
      learn: (args) => learn({ ...args, current, previous, kind }),
      onStep: (step) => {
        job.step = step;
      },
    });
    const learned = result.learned ?? { verdict: 'none', text: 'The finder gave nothing back. Nothing was changed.', candidates: [] };
    const at = this.now().toISOString();
    const simulated = Boolean(this.market?.provider?.isSimulated);
    const st = await this.#state(userId, kind);
    st.last = {
      at,
      day: istParts(this.now()).dateKey,
      by,
      verdict: learned.verdict,
      text: learned.text,
      pick: learned.pick ?? null,
      baseline: learned.baseline ?? null,
      candidates: learned.candidates ?? [],
      previousResult: learned.previousResult ?? null,
      tried: learned.tried ?? 0,
      trainDays: learned.trainDays,
      testDays: learned.testDays,
      period: result.period ?? null,
      pricing: kind === 'options' ? (result.pricing?.mode === 'estimated' ? 'estimated' : 'real') : null,
      currentCount: current.length,
      simulated,
    };
    const entries = [{ at, action: 'checked', verdict: learned.verdict, text: learned.text, ...brief(learned.pick), baselineTest: learned.baseline?.test?.net ?? 0 }];
    if (st.auto && !simulated) {
      const change = await this.#autoChange(userId, kind, learned, previous);
      if (change) entries.unshift({ at, ...change });
    }
    st.log = [...entries, ...st.log].slice(0, LOG_MAX);
    st.markModified('log');
    await st.save();
    return st.last;
  }

  /** With auto on: use a new pick, keep the same one, or switch the old pick off when it stopped passing. Returns the log entry, or null. */
  async #autoChange(userId, kind, learned, previous) {
    if (learned.verdict === 'found') {
      if (previous?.on && sameCombo(previous, learned.pick)) return { action: 'kept', ...brief(learned.pick), text: 'Still the best: kept as it is.' };
      await this.#setSlot(userId, kind, slotCombo(learned.pick));
      return { action: previous ? 'replaced' : 'added', ...brief(learned.pick), from: previous?.name ?? null, text: previous ? `Replaced ${previous.name}.` : 'Added to your combinations (paper trading).', test: learned.pick.test, baselineTest: learned.baseline?.test?.net ?? 0 };
    }
    if (learned.verdict === 'none' && previous?.on && learned.previousResult && !learned.previousResult.passed) {
      await this.#setSlot(userId, kind, { ...previous, on: false });
      return { action: 'paused', name: previous.name, conds: previous.conds, side: previous.side ?? null, text: `Switched off: ${learned.previousResult.why.join('; ')}.` };
    }
    return null;
  }

  /** Puts the learner's combination in its slot (or takes the slot out with null). The user's own combinations are not touched. */
  async #setSlot(userId, kind, combo) {
    const settings = await this.#settings(userId, kind);
    const others = normalizeCombos(settings.combos).filter((c) => c.id !== LEARNER_SLOT);
    if (combo && others.length >= MAX_COMBOS) throw conflict(`You have ${MAX_COMBOS} combinations saved, the most allowed. Delete one so the learner has room.`);
    settings.combos = combo ? [...others, combo] : others;
    await settings.save();
  }

  /** "Use it": put the last run's pick in the slot by hand. */
  async use(userId, kind) {
    const st = await this.#state(userId, kind);
    const pick = st.last?.verdict === 'found' ? st.last.pick : null;
    if (!pick) throw badRequest('There is no pick to use. Run the learner first.');
    await this.#setSlot(userId, kind, slotCombo(pick));
    st.log = [{ at: this.now().toISOString(), action: 'used', ...brief(pick), text: 'Used by you.', test: pick.test }, ...st.log].slice(0, LOG_MAX);
    st.markModified('log');
    await st.save();
    return this.view(userId, kind);
  }

  /** Undo: the learner's combination comes out of the saved list and auto is turned off, so it is not put back tonight. */
  async undo(userId, kind) {
    const settings = await modelOf(kind).findOne({ user: userId }).lean();
    const slot = normalizeCombos(settings?.combos).find((c) => c.id === LEARNER_SLOT);
    await this.#setSlot(userId, kind, null);
    const st = await this.#state(userId, kind);
    st.auto = false;
    st.log = [{ at: this.now().toISOString(), action: 'undone', name: slot?.name ?? null, text: slot ? `Took out ${slot.name} and turned auto off.` : 'Turned auto off.' }, ...st.log].slice(0, LOG_MAX);
    st.markModified('log');
    await st.save();
    return this.view(userId, kind);
  }

  async setAuto(userId, kind, on) {
    const st = await this.#state(userId, kind);
    st.auto = Boolean(on);
    await st.save();
    return this.view(userId, kind);
  }

  /** The log, each change with how the learner's combination then did live (paper) until the next change. */
  async liveResults(userId, kind, log) {
    if (!log.length) return [];
    const changes = log.filter((e) => CHANGES.includes(e.action));
    if (!changes.length) return log;
    const oldest = new Date(Math.min(...changes.map((e) => Date.parse(e.at))));
    const rows = await AutoLog.find({ user: userId, segment: segmentOf(kind), decision: 'PLACED', status: 'CLOSED', 'detail.comboId': LEARNER_SLOT, decidedAt: { $gte: oldest } }, 'outcome.netPnl decidedAt').lean();
    const ends = log.filter((e) => ENDS.includes(e.action)).map((e) => Date.parse(e.at));
    return log.map((e) => {
      if (!CHANGES.includes(e.action)) return e;
      const from = Date.parse(e.at);
      const until = Math.min(...ends.filter((t) => t > from), Infinity);
      const mine = rows.filter((r) => +new Date(r.decidedAt) >= from && +new Date(r.decidedAt) < until);
      const net = Math.round(mine.reduce((s, r) => s + (r.outcome?.netPnl ?? 0), 0) * 100) / 100;
      return { ...e, live: { trades: mine.length, wins: mine.filter((r) => r.outcome?.netPnl > 0).length, net, ended: until !== Infinity } };
    });
  }

  /** Shares: the learner's combination is switched off after BENCH_AFTER live losses in a row (options have the bench in Account > Limits). */
  async benchShares(userId) {
    const settings = await AutoSettings.findOne({ user: userId });
    const list = normalizeCombos(settings?.combos);
    const slot = list.find((c) => c.id === LEARNER_SLOT);
    if (!slot?.on) return false;
    const last = await AutoLog.find({ user: userId, segment: { $ne: 'OPT' }, decision: 'PLACED', status: 'CLOSED', 'detail.comboId': LEARNER_SLOT }, 'outcome.netPnl').sort({ decidedAt: -1 }).limit(BENCH_AFTER).lean();
    if (last.length < BENCH_AFTER || last.some((e) => !(e.outcome?.netPnl < 0))) return false;
    slot.on = false;
    slot.benchedOn = istParts(this.now()).dateKey;
    settings.combos = list;
    await settings.save();
    await LearnerState.updateOne({ user: userId, kind: 'shares' }, { $push: { log: { $each: [{ at: this.now().toISOString(), action: 'benched', name: slot.name, text: `Switched off after ${BENCH_AFTER} live losses in a row.` }], $position: 0, $slice: LOG_MAX } } });
    return true;
  }

  /** One check of the evening schedule: on a trading day after RUN_AFTER_MIN, each user with auto on is run once (options, then shares). */
  async tick() {
    if (this.market?.provider?.isSimulated) return; // the mock feed's history is random: nothing to learn from
    const now = this.now();
    const { minutes, dateKey } = istParts(now);
    for (const st of await LearnerState.find({ kind: 'shares', auto: true }, 'user').lean()) await this.benchShares(st.user).catch((e) => logger.warn(`learner bench failed: ${e.message}`));
    if (!isTradingDay(now, this.config.nseHolidays ?? []) || minutes < RUN_AFTER_MIN) return;
    const due = await LearnerState.find({ auto: true, 'last.day': { $ne: dateKey } }, 'user kind').lean();
    due.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    for (const st of due) {
      if (this.status(String(st.user), st.kind).state === 'running') continue;
      await this.start(String(st.user), st.kind, { by: 'evening' }).done;
    }
  }

  schedule() {
    const run = () => this.tick().catch((e) => logger.warn(`learner schedule failed: ${e.message}`));
    this.timer = setInterval(run, TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
