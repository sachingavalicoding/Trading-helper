import { StudyRun, OptionSettings } from '../models/index.js';
import { loadRules } from '../models/TradeDefaults.js';
import { NIFTY50 } from '../market/instruments.js';
import { UNDERLYING } from '../options/symbols.js';
import { conflict } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { runOptionsStudy } from './optionsStudy.js';
import { runSharesStudy } from './sharesStudy.js';

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
  start(userId, kind, { days, iv = 0.14, exit = 'lock', target = 1000, fixedLots = 0 } = {}) {
    if (this.status(userId, kind).state === 'running') throw conflict('A study is already running');
    const job = { state: 'running', step: 'Starting', startedAt: Date.now() };
    this.jobs.set(`${userId}|${kind}`, job);
    const run = kind === 'shares' ? this.#runShares(userId, job, { days: days ?? 8 }) : this.#runOptions(userId, job, { days: days ?? 20, iv, target: exit === 'target' ? target : 0, fixedLots });
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

  async #nifty(job, days) {
    const calendar = Math.ceil((days * 7) / 5) + WARMUP_DAYS;
    job.step = 'Reading Nifty candles';
    const nifty1 = await this.market.getRange(UNDERLYING, 1, calendar);
    if (nifty1.length < 400) throw new Error('Not enough Nifty history came back. On Upstox, log in again (the token lasts one day) and retry.');
    return { nifty1, calendar };
  }

  async #runOptions(userId, job, { days, iv, target = 0, fixedLots = 0 }) {
    const { nifty1, calendar } = await this.#nifty(job, days);
    const stocks5 = {};
    let failed = 0;
    for (const [n, { symbol }] of NIFTY50.entries()) {
      job.step = `Reading the 50 stocks (${n + 1}/50)`;
      try {
        stocks5[symbol] = await this.market.getRange(symbol, 5, calendar);
      } catch {
        failed += 1;
        if (failed >= 5 && !Object.keys(stocks5).length) break; // the broker is refusing: stop asking
      }
    }
    const [rules, settings] = await Promise.all([loadRules(userId, 'OPT'), OptionSettings.findOne({ user: userId }).lean()]);
    const params = {
      days,
      iv,
      lockStart: rules.lockStart || 1000,
      lockGap: rules.lockGap || 250,
      lotSize: this.config.niftyLotSize,
      holidays: this.config.nseHolidays,
      expiryWeekday: this.market.expiryWeekday,
      minScore: settings?.minScore ?? 80,
      lossLimit: rules.stopLoss ?? 0,
      maxLots: settings?.maxLots ?? 2,
      target,
      fixedLots,
    };
    const result = await runOptionsStudy({ nifty1, stocks5, params, onProgress: (step) => { job.step = step; } });
    await this.#save(userId, 'options', result);
  }

  async #runShares(userId, job, { days }) {
    const { nifty1, calendar } = await this.#nifty(job, days);
    const history = {};
    let failed = 0;
    for (const [n, { symbol }] of NIFTY50.entries()) {
      job.step = `Reading the 50 stocks (${n + 1}/50)`;
      try {
        history[symbol] = await this.market.getRange(symbol, 1, calendar);
      } catch {
        failed += 1;
        if (failed >= 5 && !Object.keys(history).length) break;
      }
    }
    const rules = await loadRules(userId, 'EQ');
    const result = await runSharesStudy({ nifty1, history, params: { days, riskAmount: rules.stopLoss }, onProgress: (step) => { job.step = step; } });
    await this.#save(userId, 'shares', result);
  }
}
