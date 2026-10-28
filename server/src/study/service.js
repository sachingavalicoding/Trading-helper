import { StudyRun, OptionSettings } from '../models/index.js';
import { loadRules } from '../models/TradeDefaults.js';
import { NIFTY50 } from '../market/instruments.js';
import { UNDERLYING } from '../options/symbols.js';
import { conflict } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { runOptionsStudy } from './optionsStudy.js';

const WARMUP_DAYS = 6; // calendar days read before the study starts, so the indicators have context on its first day

/** Runs the options study in the background and keeps the latest result per user. Read-only: it places no orders. */
export class StudyService {
  constructor({ market, config }) {
    this.market = market;
    this.config = config;
    this.jobs = new Map(); // userId -> { state: 'running' | 'failed', step, startedAt, error }
  }

  status(userId) {
    return this.jobs.get(String(userId)) || { state: 'idle' };
  }

  async latest(userId) {
    const doc = await StudyRun.findOne({ user: userId, kind: 'options' }).lean();
    return doc ? { ...doc.result, simulated: doc.simulated } : null;
  }

  /** Starts a run and returns at once; poll status(). Only one run per user at a time. */
  start(userId, { days = 20, iv = 0.14 } = {}) {
    if (this.status(userId).state === 'running') throw conflict('A study is already running');
    const job = { state: 'running', step: 'Starting', startedAt: Date.now() };
    this.jobs.set(String(userId), job);
    this.#run(userId, job, { days, iv }).catch((e) => {
      logger.warn(`options study failed: ${e.message}`);
      Object.assign(job, { state: 'failed', error: e.message });
    });
    return job;
  }

  async #run(userId, job, { days, iv }) {
    const calendar = Math.ceil((days * 7) / 5) + WARMUP_DAYS;
    job.step = 'Reading Nifty candles';
    const nifty1 = await this.market.getRange(UNDERLYING, 1, calendar);
    if (nifty1.length < 400) throw new Error('Not enough Nifty history came back. On Upstox, log in again (the token lasts one day) and retry.');
    const stocks5 = {};
    let failed = 0;
    for (const [n, { symbol }] of NIFTY50.entries()) {
      job.step = `Reading the 50 stocks (${n + 1}/50)`;
      try {
        stocks5[symbol] = await this.market.getRange(symbol, 5, calendar);
      } catch (e) {
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
    };
    const result = await runOptionsStudy({ nifty1, stocks5, params, onProgress: (step) => { job.step = step; } });
    const simulated = Boolean(this.market.provider.isSimulated);
    await StudyRun.findOneAndUpdate({ user: userId, kind: 'options' }, { result, simulated }, { upsert: true, new: true });
    this.jobs.delete(String(userId));
  }
}
