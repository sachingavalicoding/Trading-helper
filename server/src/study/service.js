import { dayBiasOf } from '../options/dayBias.js';
import { StudyRun, OptionSettings, AutoSettings } from '../models/index.js';
import { normalizeCombos } from '../combos/combos.js';
import { stopRuleOf } from './patterns.js';
import { forIndex } from '../options/indexSettings.js';
import { entryWindowOf } from '../options/signal.js';
import { breakEvenOf, trailOf } from './simulate.js';
import { loadRules, TradeDefaults } from '../models/TradeDefaults.js';
import { NIFTY50 } from '../market/instruments.js';
import { INDEXES, DEFAULT_INDEX, lotSizeOf } from '../options/symbols.js';
import { conflict } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { runOptionsStudy, runLadderStudy, runMovedStudy } from './optionsStudy.js';
import { chaseOf } from '../options/chase.js';
import { movedOf } from '../options/moved.js';
import { entryModes } from '../options/optionTrader.js';
import { runSharesStudy } from './sharesStudy.js';
import { PriceBook, firstStudyDay } from './priceBook.js';

const WARMUP_DAYS = 6; // calendar days read before the study starts, so the indicators have context on its first day

/** Runs a study in the background and keeps the latest result per user and kind ('options' or 'shares'). Read-only: it places no orders. */
export class StudyService {
  constructor({ market, config }) {
    this.market = market;
    this.config = config;
    this.jobs = new Map(); // `${userId}|${kind}` -> { state: 'running' | 'failed', step, startedAt, error }
  }

  status(userId, kind = 'options') {
    return this.jobs.get(`${userId}|${kind}`) || { state: 'idle' };
  }

  async latest(userId, kind = 'options') {
    const doc = await StudyRun.findOne({ user: userId, kind }).lean();
    return doc ? { ...doc.result, simulated: doc.simulated } : null;
  }

  /** Starts a run and returns at once; poll status(). Only one run per user and kind at a time. */
  start(userId, kind, { realPrices = true, live = true, maxTrades, days, iv = 0.14, exit = 'lock', target = 1000, fixedLots = 0, exitMin, autoFind = false, research = false, index = DEFAULT_INDEX, pairFind = false, pairFirst = null, comboFind = false, from, to, pairDepth, pairShow, pairGoal, pairResearch, pairParts, winFind = false, winMinWin, winMinTrades } = {}) {
    if (this.status(userId, kind).state === 'running') throw conflict('A study is already running');
    const job = { state: 'running', step: 'Starting', startedAt: Date.now() };
    this.jobs.set(`${userId}|${kind}`, job);
    const finder = { pairDepth, pairShow, pairGoal, pairResearch, pairParts, winFind, winMinWin, winMinTrades };
    const run = kind === 'ladder' ? this.#runLadder(userId, job, { index, days: days ?? 30 }) : kind === 'moved' ? this.#runMoved(userId, job, { index, days: days ?? 30 }) : kind === 'shares' ? this.#runShares(userId, job, { days: days ?? 8, target: exit === 'target' ? target : 0, exitMin, pairFind, pairFirst, comboFind, ...finder }) : this.#runOptions(userId, job, { days: days ?? 20, iv, target: exit === 'target' ? target : 0, fixedLots, exitMin, autoFind, research, index, pairFind, pairFirst, comboFind, from, to, realPrices, live, maxTrades, ...finder });
    run.catch((e) => {
      logger.warn(`${kind} study failed: ${e.message}`);
      Object.assign(job, { state: 'failed', error: e.message });
    });
    return job;
  }

  async #save(userId, kind, result) {
    const simulated = Boolean(this.market.provider.isSimulated);
    await StudyRun.findOneAndUpdate({ user: userId, kind }, { result, simulated }, { upsert: true, new: true });
    this.jobs.delete(`${userId}|${kind}`);
  }

  /** Candles for a study: from the saved history when there is one, else from the broker. */
  #range(symbol, unit, days) {
    return typeof this.market.getStudyRange === 'function' ? this.market.getStudyRange(symbol, unit, days) : this.market.getRange(symbol, unit, days);
  }

  async #nifty(job, days, index = DEFAULT_INDEX, from = null) {
    const back = from ? Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1 : Math.ceil((days * 7) / 5); // calendar days back to the first day wanted
    const calendar = back + WARMUP_DAYS;
    const idx = INDEXES[index];
    job.step = `Reading ${idx.short} candles`;
    const nifty1 = await this.#range(idx.symbol, 1, calendar);
    if (nifty1.length < 400) throw new Error(`Not enough ${idx.short} history came back. On Upstox, log in again (the token lasts one day), press Download in Account > Studies > Data, and retry.`);
    return { nifty1, calendar };
  }

  async #runOptions(userId, job, { realPrices = false, live = true, maxTrades, days, iv, target = 0, fixedLots = 0, exitMin, autoFind = false, research = false, index = DEFAULT_INDEX, pairFind = false, pairFirst = null, comboFind = false, from, to, pairDepth, pairShow, pairGoal, pairResearch, pairParts, winFind = false, winMinWin, winMinTrades }) {
    // with the real prices on, the study covers only the days that were saved (inside any dates asked for), and takes only trades whose contract was saved
    let prices = null;
    let noPrices = false;
    if (realPrices) {
      job.step = 'Reading the saved real option prices';
      prices = await PriceBook.load(index);
      if (!prices.days.length) {
        noPrices = true; // nothing saved yet: run on the model's estimate and say so in the result
        prices = null;
      }
    }
    if (prices) {
      const [first, last] = [prices.days[0], prices.days.at(-1)];
      from = firstStudyDay(prices.days, { days, from }); // 10 days = the newest 10 saved days, not everything saved
      to = to && to < last ? to : last;
      if (from > to) throw new Error(`Real option prices are saved from ${first} to ${last}. Pick dates inside that.`);
    }
    const { nifty1, calendar } = await this.#nifty(job, days, index, from);
    const stocks5 = {};
    let failed = 0;
    for (const [n, { symbol }] of NIFTY50.entries()) {
      job.step = `Reading the 50 stocks (${n + 1}/50)`;
      try {
        stocks5[symbol] = await this.#range(symbol, 5, calendar);
      } catch {
        failed += 1;
        if (failed >= 5 && !Object.keys(stocks5).length) break; // the broker is refusing: stop asking
      }
    }
    const [rules, settings] = await Promise.all([loadRules(userId, 'OPT', { index }), OptionSettings.findOne({ user: userId }).lean().then((s) => forIndex(s, index))]);
    const window = entryWindowOf(settings);
    const params = {
      days,
      iv,
      prices,
      lockStart: rules.lockStart || 1000,
      lockGap: rules.lockGap || 250,
      steps: rules.steps,
      index,
      lotSize: lotSizeOf(index, this.config),
      holidays: this.config.nseHolidays,
      expiryWeekday: this.market.weekdayOf?.(index) ?? this.market.expiryWeekday,
      strikeStep: INDEXES[index].strikeStep,
      minScore: settings?.minScore ?? 80,
      live,
      maxTrades: maxTrades ?? (live ? settings?.maxTrades : null) ?? 3,
      dailyLoss: live && settings ? (settings.budget * settings.dailyLossPct) / 100 : 0,
      lossStreak: live ? settings?.lossStreak ?? 2 : 0,
      combos: normalizeCombos(settings?.combos),
      stopRule: stopRuleOf(settings, index),
      entryFrom: window.from,
      entryTo: window.to,
      trail: trailOf(settings),
      breakEven: breakEvenOf(settings),
      chase: chaseOf(settings),
      withDay: dayBiasOf(settings),
      comboStreak: settings?.comboStreak ?? 0,
      moved: movedOf(settings),
      autoFind,
      pairFind,
      pairFirst,
      comboFind,
      from,
      to,
      pairDepth,
      pairShow,
      pairGoal,
      pairResearch,
      pairParts,
      winFind,
      winMinWin,
      winMinTrades,
      finderOnly: pairFind || comboFind || winFind, // with a finder on, only the finders run, not the normal study
      research,
      lossLimit: rules.stopLoss ?? 0,
      maxLots: settings?.maxLots ?? 2,
      sideOnly: settings?.sideOnly ?? null,
      target,
      fixedLots,
      exitMin: exitMin ?? rules.exitMin,
    };
    const result = await runOptionsStudy({ nifty1, stocks5, params, onProgress: (step) => { job.step = step; } });
    result.pricing = prices ? prices.describe() : { mode: 'estimated', iv, ...(noPrices ? { note: 'No real option prices are saved for this index yet (one day is saved each evening after 15:40), so the premiums are estimated.' } : {}) };
    await this.#save(userId, 'options', result);
  }

  /** The ladder tester: the live entries on the saved real option prices, sold with many profit ladders and with the anti-chase check. */
  async #runLadder(userId, job, { index = DEFAULT_INDEX, days = 30 }) {
    const { nifty1, stocks5, params, prices } = await this.#liveReplay(userId, job, { index, days });
    const result = await runLadderStudy({ nifty1, stocks5, params, onProgress: (step) => { job.step = step; } });
    result.pricing = prices.describe();
    result.applyKey = 'options'; // where "Use this ladder" saves it
    result.lockOn = params.lockOn;
    await this.#save(userId, 'ladder', result);
  }

  /** The "already moved" tester: the live entries on the saved real option prices, with each limit on how far the index (or the premium) had already run. */
  async #runMoved(userId, job, { index = DEFAULT_INDEX, days = 30 }) {
    const { nifty1, stocks5, params, prices, settings } = await this.#liveReplay(userId, job, { index, days });
    params.entryKey = 'entryTo'; // where "No new trade from" is saved
    const result = await runMovedStudy({ nifty1, stocks5, params, onProgress: (step) => { job.step = step; } });
    result.pricing = prices.describe();
    result.now = { moved: movedOf(settings), chase: chaseOf(settings), entryTo: params.entryTo };
    await this.#save(userId, 'moved', result);
  }

  /** What both testers replay: the Nifty (or Sensex) minutes, the 50 stocks, and the live trader's own settings as study params. */
  async #liveReplay(userId, job, { index = DEFAULT_INDEX, days = 30 }) {
    job.step = 'Reading the saved real option prices';
    const prices = await PriceBook.load(index);
    if (!prices.days.length) throw new Error('No real option prices are saved yet. They are saved each evening after 15:40 while the server runs and Upstox is logged in, or press Download in Research > Saved data.');
    const from = firstStudyDay(prices.days, { days });
    const to = prices.days.at(-1);
    const { nifty1 } = await this.#nifty(job, days, index, from);
    const stocks5 = {};
    let failed = 0;
    for (const [n, { symbol }] of NIFTY50.entries()) {
      job.step = `Reading the 50 stocks (${n + 1}/50)`;
      try {
        stocks5[symbol] = await this.#range(symbol, 5, Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1 + WARMUP_DAYS);
      } catch {
        failed += 1;
        if (failed >= 5 && !Object.keys(stocks5).length) break;
      }
    }
    const [rules, raw] = await Promise.all([loadRules(userId, 'OPT', { index }), OptionSettings.findOne({ user: userId }).lean()]);
    const settings = forIndex(raw || new OptionSettings({ user: userId }).toObject(), index);
    const window = entryWindowOf(settings);
    const modes = entryModes(settings);
    const params = {
      days,
      from,
      to,
      prices,
      iv: 0.14,
      steps: rules.steps,
      index,
      lotSize: lotSizeOf(index, this.config),
      holidays: this.config.nseHolidays,
      expiryWeekday: this.market.weekdayOf?.(index) ?? this.market.expiryWeekday,
      strikeStep: INDEXES[index].strikeStep,
      live: true,
      maxTrades: settings?.maxTrades ?? 3,
      dailyLoss: settings ? (settings.budget * settings.dailyLossPct) / 100 : 0,
      lossStreak: settings?.lossStreak ?? 2,
      combos: normalizeCombos(settings?.combos),
      comboEntries: modes.combos,
      patterns: modes.patterns,
      scoreEntries: modes.score,
      scoreMin: settings?.minScore ?? 70,
      patternMinScore: settings?.patternMinScore ?? 0,
      comboMinScore: settings?.comboMinScore ?? 0,
      stopRule: stopRuleOf(settings, index),
      entryFrom: window.from,
      entryTo: window.to,
      trail: trailOf(settings),
      breakEven: breakEvenOf(settings),
      chase: chaseOf(settings),
      withDay: dayBiasOf(settings),
      comboStreak: settings?.comboStreak ?? 0,
      moved: movedOf(settings),
      lossLimit: rules.stopLoss ?? 0,
      maxLots: settings?.maxLots ?? 2,
      sideOnly: settings?.sideOnly ?? null,
      target: 0,
      exitMin: rules.exitMin,
    };
    params.lockOn = rules.lockOn !== false;
    return { nifty1, stocks5, params, prices, settings };
  }

  async #runShares(userId, job, { days, target = 0, exitMin, pairFind = false, pairFirst = null, comboFind = false, pairDepth, pairShow, pairGoal, pairParts }) {
    const { nifty1, calendar } = await this.#nifty(job, days);
    const history = {};
    let failed = 0;
    for (const [n, { symbol }] of NIFTY50.entries()) {
      job.step = `Reading the 50 stocks (${n + 1}/50)`;
      try {
        history[symbol] = await this.#range(symbol, 1, calendar);
      } catch {
        failed += 1;
        if (failed >= 5 && !Object.keys(history).length) break;
      }
    }
    const [rules, auto] = await Promise.all([loadRules(userId, 'EQ'), AutoSettings.findOne({ user: userId }).lean()]);
    const result = await runSharesStudy({ nifty1, history, params: { days, riskAmount: rules.stopLoss, steps: rules.steps, target, exitMin: exitMin ?? rules.exitMin, maxAmount: auto?.maxTradeAmount ?? 0, settings: auto ?? null, combos: normalizeCombos(auto?.combos), pairFind, pairFirst, comboFind, pairDepth, pairShow, pairGoal, pairParts, finderOnly: pairFind || comboFind }, onProgress: (step) => { job.step = step; } });
    await this.#save(userId, 'shares', result);
  }
}
