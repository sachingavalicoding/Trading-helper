import { NIFTY50 } from './instruments.js';
import { UNDERLYING } from '../options/symbols.js';
import { addDays } from './days.js';
import { HistoryStore, RETAIN_DAYS } from './historyStore.js';
import { conflict, badRequest } from '../utils/errors.js';
import { istParts } from './marketHours.js';
import { logger } from '../utils/logger.js';

const WINDOW_DAYS = 27; // the history API reads a month at most per request
const TOP_UP_AFTER_MIN = 15 * 60 + 40; // the automatic top-up runs after the close, when the day's candles are all in
const CHECK_EVERY_MS = 10 * 60000;

/** The date windows to read, newest first, between two days (inclusive). */
export function windowsBack(fromDay, toDay) {
  const out = [];
  let to = toDay;
  while (to >= fromDay) {
    const from = addDays(to, -(WINDOW_DAYS - 1));
    out.push({ from: from < fromDay ? fromDay : from, to });
    to = addDays(from, -1);
  }
  return out;
}

/** Reads the 1-minute candles of the Nifty and the 50 stocks from the broker once, keeps them in the database, and tops them up each evening. */
export class HistorySync {
  constructor({ market, store = market.history ?? new HistoryStore(), now = () => new Date(), symbols = [UNDERLYING, ...NIFTY50.map((s) => s.symbol)] }) {
    this.market = market;
    this.store = store;
    market.history = store; // the studies and Review read through the market service
    this.now = now;
    this.symbols = symbols;
    this.job = { state: 'idle' };
    this.timer = null;
  }

  status() {
    return this.job;
  }

  /**
   * Starts the download of the last `days` days (what is already saved is skipped) and returns at once. With `live`, today's candles so far
   * are saved too (read again on each press), so a study can use the running day.
   */
  start({ days = RETAIN_DAYS - 1, live = false } = {}) {
    if (this.job.state === 'running') throw conflict('The download is already running');
    if (this.market.provider.isSimulated) throw badRequest('The sample feed has no real history. Log in to Upstox first.', 'NO_HISTORY');
    const job = { state: 'running', step: 'Starting', done: 0, total: this.symbols.length, failed: [], startedAt: Date.now() };
    this.job = job;
    this.#run(job, days, live)
      .then(() => Object.assign(job, { state: job.failed.length ? 'partial' : 'done', step: '', finishedAt: Date.now() }))
      .catch((e) => {
        logger.warn(`History download failed: ${e.message}`);
        Object.assign(job, { state: 'failed', error: e.message, finishedAt: Date.now() });
      });
    return job;
  }

  async #run(job, days, live) {
    const last = this.store.lastCompleteDay();
    const startDay = addDays(last, -days);
    for (const [n, symbol] of this.symbols.entries()) {
      job.step = `${symbol} (${n + 1}/${this.symbols.length})`;
      try {
        await this.#symbol(symbol, startDay, last, live);
      } catch (e) {
        job.failed.push({ symbol, error: String(e.message).slice(0, 120) });
        logger.warn(`History for ${symbol} stopped: ${e.message}`);
        if (job.failed.length >= 5 && job.done === 0) throw new Error(`Upstox keeps refusing: ${e.message}`);
      }
      job.done = n + 1;
    }
    job.step = 'Removing days older than three months';
    await this.store.prune();
  }

  /** Fills what is missing for one symbol: the days after what is saved, then the days before it, window by window so a stop loses little. */
  async #symbol(symbol, startDay, last, live) {
    const cov = await this.store.coverage(symbol);
    const todo = [];
    // a day saved only up to some time is read again from its start, as a whole day once the session is over
    const have = cov?.partial && cov.partial <= last ? addDays(cov.partial, -1) : cov?.to;
    if (!cov) todo.push(...windowsBack(startDay, last));
    else {
      if (have < last) todo.push(...windowsBack(addDays(have, 1), last).reverse());
      if (cov.from > startDay) todo.push(...windowsBack(startDay, addDays(cov.from, -1)));
    }
    for (const w of todo) {
      const candles = await this.market.provider.getCandlesBetween(symbol, 1, w.from, w.to);
      await this.store.saveCandles(symbol, candles);
      await this.store.setCoverage(symbol, w);
    }
    const today = this.store.today;
    if (live && today > last) {
      const candles = (await this.market.provider.getTodayCandles(symbol, 1)).filter((c) => istParts(new Date(c.time * 1000)).dateKey === today);
      if (candles.length) {
        await this.store.saveCandles(symbol, candles, { live: true });
        await this.store.setCoverage(symbol, { from: today, to: today, partial: today });
      }
    }
  }

  /** Is the saved history behind the last finished session? Only a history that has been downloaded once is topped up by itself. */
  async behind() {
    const cov = await this.store.coverage(UNDERLYING);
    const last = this.store.lastCompleteDay();
    return Boolean(cov) && (cov.to < last || Boolean(cov.partial && cov.partial <= last));
  }

  /** Every few minutes: after the close, add the day to the saved history, and trim it to three months. */
  schedule() {
    const tick = async () => {
      try {
        if (this.job.state === 'running' || this.market.provider.isSimulated) return;
        const { minutes } = istParts(this.now());
        const weekday = new Date(this.now().getTime() + 19800000).getUTCDay();
        const evening = minutes >= TOP_UP_AFTER_MIN && weekday >= 1 && weekday <= 5;
        if ((evening || this.store.lastCompleteDay() < this.store.today) && (await this.behind())) this.start({ days: RETAIN_DAYS - 1 });
      } catch (e) {
        logger.warn(`History top-up check failed: ${e.message}`);
      }
    };
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.timer.unref?.();
    setTimeout(tick, 60000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
