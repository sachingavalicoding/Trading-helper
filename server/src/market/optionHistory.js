import { gunzipSync, gzipSync } from 'node:zlib';
import { OptionCandleDay, OptionHistoryDay } from '../models/OptionCandleDay.js';
import { INDEXES } from '../options/symbols.js';
import { istParts } from './marketHours.js';
import { conflict, badRequest } from '../utils/errors.js';
import { addDays } from './days.js';
import { logger } from '../utils/logger.js';

// The real premiums of index options, saved each evening for the last RETAIN_DAYS trading days. Upstox lists only live contracts
// and keeps expired ones behind its Plus plan, so the days are collected as they happen: today's 1-minute candles of the contracts
// that were near the money, one document per contract and day. When a new day is added, the oldest one beyond RETAIN_DAYS is deleted.

export const RETAIN_DAYS = 30; // trading days kept
const EXPIRIES = 2; // the nearest expiries
const MARGIN_STEPS = 4; // strikes kept beyond the day's low and high
const MAX_STRIKES = 41;
const SAVE_AFTER_MIN = 15 * 60 + 40; // the session's candles are all in
const CHECK_EVERY_MS = 10 * 60000;
const TRIES_A_DAY = 3;
const WINDOW_DAYS = 27; // the history API reads a month at most per request

/** Candles of one contract-day -> Buffer: seven columns (time, open, high, low, close in paise, volume, open interest), each as the change from the row before, gzipped. */
export function packOptionCandles(candles) {
  const n = candles.length;
  const cols = new Int32Array(n * 7);
  const prev = [0, 0, 0, 0, 0, 0, 0];
  const cap = (v) => Math.min(Math.round(v || 0), 2147483647);
  candles.forEach((c, i) => {
    const row = [c.time, Math.round(c.open * 100), Math.round(c.high * 100), Math.round(c.low * 100), Math.round(c.close * 100), cap(c.volume), cap(c.oi)];
    row.forEach((v, k) => {
      cols[k * n + i] = v - prev[k];
      prev[k] = v;
    });
  });
  return gzipSync(Buffer.from(cols.buffer));
}

/** Buffer -> candles, oldest first. */
export function unpackOptionCandles(buf, count) {
  const raw = gunzipSync(buf);
  const cols = new Int32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const sum = [0, 0, 0, 0, 0, 0, 0];
  const out = [];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 7; k++) sum[k] += cols[k * count + i];
    out.push({ time: sum[0], open: sum[1] / 100, high: sum[2] / 100, low: sum[3] / 100, close: sum[4] / 100, volume: sum[5], oi: sum[6] });
  }
  return out;
}

/** The contracts worth saving for a day: both types, every strike from a few steps below the index's low to a few above its high (at most MAX_STRIKES, nearest the close first). */
export function pickContracts(rows, { low, high, close, step }) {
  const floor = Math.floor((low - MARGIN_STEPS * step) / step) * step;
  const ceil = Math.ceil((high + MARGIN_STEPS * step) / step) * step;
  const strikes = [...new Set(rows.map((r) => r.strike))]
    .filter((k) => k >= floor && k <= ceil)
    .sort((a, b) => Math.abs(a - close) - Math.abs(b - close) || a - b)
    .slice(0, MAX_STRIKES);
  const keep = new Set(strikes);
  return rows.filter((r) => keep.has(r.strike)).sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
}

/** The saved option premiums: add a day, read them back, keep the last RETAIN_DAYS trading days. */
export class OptionHistoryStore {
  constructor({ now = () => new Date(), retainDays = RETAIN_DAYS } = {}) {
    this.now = now;
    this.retainDays = retainDays;
  }

  get today() {
    return istParts(this.now()).dateKey;
  }

  async saveContract(index, row, day, candles) {
    const list = candles.filter((c) => istParts(new Date(c.time * 1000)).dateKey === day);
    if (!list.length) return false;
    await OptionCandleDay.updateOne(
      { symbol: row.symbol, day },
      { $set: { index, expiry: row.expiry, strike: row.strike, type: row.type, lotSize: row.lotSize ?? 0, count: list.length, data: packOptionCandles(list) } },
      { upsert: true },
    );
    return true;
  }

  async markDone(index, day, contracts, spot, { backfilled = false } = {}) {
    await OptionHistoryDay.updateOne({ index, day }, { $set: { contracts, spot, backfilled } }, { upsert: true });
  }

  async isDone(index, day) {
    return Boolean(await OptionHistoryDay.exists({ index, day }));
  }

  /** The real 1-minute candles of one contract from `fromDay` to `toDay`, oldest first. */
  async read(symbol, fromDay, toDay) {
    const docs = await OptionCandleDay.find({ symbol, day: { $gte: fromDay, $lte: toDay } }).sort({ day: 1 }).lean();
    return docs.flatMap((d) => unpackOptionCandles(d.data.buffer ? Buffer.from(d.data.buffer) : d.data, d.count));
  }

  /** Deletes the days beyond the newest `retainDays`. Returns how many days were removed. */
  async prune() {
    const days = (await OptionHistoryDay.distinct('day')).sort().reverse();
    if (days.length <= this.retainDays) return 0;
    const oldest = days[this.retainDays - 1];
    await OptionCandleDay.deleteMany({ day: { $lt: oldest } });
    await OptionHistoryDay.deleteMany({ day: { $lt: oldest } });
    return days.length - this.retainDays;
  }

  async summary() {
    const [days, contracts, size, backfilled] = await Promise.all([
      OptionHistoryDay.distinct('day'),
      OptionCandleDay.countDocuments(),
      OptionCandleDay.aggregate([{ $group: { _id: null, bytes: { $sum: { $binarySize: '$data' } } } }]),
      OptionHistoryDay.distinct('day', { backfilled: true }),
    ]);
    const sorted = days.sort();
    return { days: sorted.length, backfilledDays: backfilled.length, from: sorted[0] ?? null, to: sorted.at(-1) ?? null, contracts, bytes: size[0]?.bytes ?? 0, keeps: this.retainDays };
  }
}

/** Collects the day's option premiums from the broker once the session is over, and tries again later the same evening if some failed. */
export class OptionHistorySync {
  constructor({ market, store = new OptionHistoryStore(), now = () => new Date(), indexes = Object.keys(INDEXES) }) {
    this.market = market;
    this.store = store;
    this.now = now;
    this.indexes = indexes;
    this.job = { state: 'idle' };
    this.timer = null;
    this.tries = new Map(); // day -> attempts
  }

  status() {
    return this.job;
  }

  /** Starts today's collection and returns at once; poll status(). With `force` an index already collected today is read again. */
  start({ force = false } = {}) {
    if (this.job.state === 'running') throw conflict('The collection is already running');
    if (this.market.provider.isSimulated) throw badRequest('The sample feed has no real option prices. Log in to Upstox first.', 'NO_HISTORY');
    const job = { state: 'running', step: 'Starting', done: 0, total: 0, failed: [], startedAt: Date.now() };
    this.job = job;
    this.#run(job, force)
      .then(() => Object.assign(job, { state: job.failed.length ? 'partial' : 'done', step: '', finishedAt: Date.now() }))
      .catch((e) => {
        logger.warn(`Option premium collection failed: ${e.message}`);
        Object.assign(job, { state: 'failed', error: e.message, finishedAt: Date.now() });
      });
    return job;
  }

  async #run(job, force) {
    const day = this.store.today;
    const provider = this.market.provider;
    for (const index of this.indexes) {
      if (!force && (await this.store.isDone(index, day))) continue;
      const idx = INDEXES[index];
      job.step = `${idx.short}: reading the index`;
      const bars = (await provider.getTodayCandles(idx.symbol, 1)).filter((c) => istParts(new Date(c.time * 1000)).dateKey === day);
      if (!bars.length) {
        job.failed.push({ index, error: 'no index candles for today' });
        continue;
      }
      const spot = { low: Math.min(...bars.map((c) => c.low)), high: Math.max(...bars.map((c) => c.high)), close: bars.at(-1).close, step: idx.strikeStep };
      const expiries = (await provider.getOptionExpiries(index)).filter((e) => e >= day).slice(0, EXPIRIES);
      const picked = [];
      for (const expiry of expiries) picked.push(...pickContracts(await provider.getOptionContracts(expiry, index), spot));
      job.total += picked.length;
      let saved = 0;
      let failed = 0;
      for (const row of picked) {
        job.step = `${idx.short} ${row.symbol}`;
        try {
          if (await this.store.saveContract(index, row, day, await provider.getTodayOptionCandles(row.symbol, 1))) saved++;
        } catch (e) {
          failed++;
          job.failed.push({ symbol: row.symbol, error: String(e.message).slice(0, 120) });
          if (failed >= 8 && saved === 0) throw new Error(`Upstox keeps refusing: ${e.message}`);
        }
        job.done++;
      }
      // a day counts as collected once nearly all of its contracts are in; a later try fills the rest
      if (saved > 0 && failed <= picked.length / 10) await this.store.markDone(index, day, saved, [spot.low, spot.high]);
    }
    job.step = 'Removing days beyond the last 30';
    await this.store.prune();
  }

  /**
   * Reads the past days of the contracts Upstox still lists (the nearest expiries) and saves each day for the strikes that were near the money that day.
   * Contracts that have already expired are gone from the broker, so those days hold only the contracts still listed, and are marked as backfilled.
   */
  startBackfill() {
    if (this.job.state === 'running') throw conflict('The collection is already running');
    if (this.market.provider.isSimulated) throw badRequest('The sample feed has no real option prices. Log in to Upstox first.', 'NO_HISTORY');
    const job = { state: 'running', kind: 'backfill', step: 'Starting', done: 0, total: 0, failed: [], startedAt: Date.now() };
    this.job = job;
    this.#backfill(job)
      .then(() => Object.assign(job, { state: job.failed.length ? 'partial' : 'done', step: '', finishedAt: Date.now() }))
      .catch((e) => {
        logger.warn(`Option premium backfill failed: ${e.message}`);
        Object.assign(job, { state: 'failed', error: e.message, finishedAt: Date.now() });
      });
    return job;
  }

  async #backfill(job) {
    const today = this.store.today;
    const from = addDays(today, -(WINDOW_DAYS - 1));
    const to = addDays(today, -1); // today is the nightly job's
    const provider = this.market.provider;
    for (const index of this.indexes) {
      const idx = INDEXES[index];
      job.step = `${idx.short}: reading the index days`;
      const bars = await provider.getCandlesBetween(idx.symbol, 1, from, to);
      const byDay = new Map();
      for (const c of bars) {
        const d = istParts(new Date(c.time * 1000)).dateKey;
        const x = byDay.get(d) ?? { low: Infinity, high: -Infinity, close: 0, at: 0 };
        x.low = Math.min(x.low, c.low);
        x.high = Math.max(x.high, c.high);
        if (c.time >= x.at) Object.assign(x, { close: c.close, at: c.time });
        byDay.set(d, x);
      }
      const expiries = (await provider.getOptionExpiries(index)).slice(0, EXPIRIES);
      const rowsBy = new Map();
      for (const expiry of expiries) rowsBy.set(expiry, await provider.getOptionContracts(expiry, index));
      // for each past day: the strikes that were near the money, from the expiries that had not yet run out
      const wanted = new Map(); // symbol -> { row, days }
      const plan = new Map(); // day -> the index's range that day
      for (const [day, x] of byDay) {
        if (await this.store.isDone(index, day)) continue;
        plan.set(day, x);
        for (const [expiry, rows] of rowsBy) {
          if (expiry < day) continue;
          for (const row of pickContracts(rows, { ...x, step: idx.strikeStep })) {
            const w = wanted.get(row.symbol) ?? { row, days: new Set() };
            w.days.add(day);
            wanted.set(row.symbol, w);
          }
        }
      }
      job.total += wanted.size;
      const saved = new Map(); // day -> contracts saved
      for (const { row, days } of wanted.values()) {
        job.step = `${idx.short} ${row.symbol}`;
        try {
          const candles = await provider.getOptionCandlesBetween(row.symbol, 1, from, to);
          for (const day of days) {
            if (await this.store.saveContract(index, row, day, candles)) saved.set(day, (saved.get(day) ?? 0) + 1);
          }
        } catch (e) {
          job.failed.push({ symbol: row.symbol, error: String(e.message).slice(0, 120) });
        }
        job.done++;
      }
      for (const [day, n] of saved) await this.store.markDone(index, day, n, [plan.get(day).low, plan.get(day).high], { backfilled: true });
    }
    job.step = 'Removing days beyond the last 30';
    await this.store.prune();
  }

  /** Every few minutes: after the close of a trading day, collect the day's premiums if they are not saved yet (a few tries a day). */
  schedule() {
    const tick = async () => {
      try {
        if (this.job.state === 'running' || this.market.provider.isSimulated) return;
        if (!this.backfillTried && (await this.store.summary()).days === 0) {
          this.backfillTried = true; // once per start of the server, when nothing is saved: read back what the broker still has
          this.startBackfill();
          return;
        }
        const { minutes, weekday, dateKey } = istParts(this.now());
        if (weekday < 1 || weekday > 5 || minutes < SAVE_AFTER_MIN) return;
        if ((this.tries.get(dateKey) ?? 0) >= TRIES_A_DAY) return;
        const pending = [];
        for (const index of this.indexes) if (!(await this.store.isDone(index, dateKey))) pending.push(index);
        if (!pending.length) return;
        this.tries.set(dateKey, (this.tries.get(dateKey) ?? 0) + 1);
        this.start();
      } catch (e) {
        logger.warn(`Option premium check failed: ${e.message}`);
      }
    };
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.timer.unref?.();
    setTimeout(tick, 90000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
