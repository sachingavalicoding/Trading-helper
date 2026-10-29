import { gunzipSync, gzipSync } from 'node:zlib';
import { CandleCoverage, CandleDay } from '../models/CandleDay.js';
import { istParts } from './marketHours.js';
import { addDays } from './days.js';

// Saved 1-minute candles for the studies and Review, so they do not ask Upstox again and again.
// A day of a symbol is one document: six columns of whole numbers (time, open, high, low, close in paise, volume), each stored as
// the change from the row before it, then gzipped. About 3 KB a day, so three months of 51 symbols is only a few megabytes.

const CLOSE_MIN = 15 * 60 + 35; // after this a session's candles are all in and the day can be saved
export const RETAIN_DAYS = 92; // three months

/** Candles of one day -> Buffer. */
export function packCandles(candles) {
  const n = candles.length;
  const cols = new Int32Array(n * 6);
  const prev = [0, 0, 0, 0, 0, 0];
  candles.forEach((c, i) => {
    const row = [c.time, Math.round(c.open * 100), Math.round(c.high * 100), Math.round(c.low * 100), Math.round(c.close * 100), Math.min(Math.round(c.volume || 0), 2147483647)];
    row.forEach((v, k) => {
      cols[k * n + i] = v - prev[k];
      prev[k] = v;
    });
  });
  return gzipSync(Buffer.from(cols.buffer));
}

/** Buffer -> candles, oldest first. */
export function unpackCandles(buf, count) {
  const raw = gunzipSync(buf);
  const cols = new Int32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = count;
  const sum = [0, 0, 0, 0, 0, 0];
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 6; k++) sum[k] += cols[k * n + i];
    out.push({ time: sum[0], open: sum[1] / 100, high: sum[2] / 100, low: sum[3] / 100, close: sum[4] / 100, volume: sum[5] });
  }
  return out;
}

const dayOf = (t) => istParts(new Date(t * 1000)).dateKey;

/** The saved history: read it, add to it, and trim it to the last three months. */
export class HistoryStore {
  constructor({ now = () => new Date(), retainDays = RETAIN_DAYS } = {}) {
    this.now = now;
    this.retainDays = retainDays;
  }

  get today() {
    return istParts(this.now()).dateKey;
  }

  /** The newest session whose candles are complete: today once the market has closed, otherwise yesterday. */
  lastCompleteDay() {
    const { minutes, dateKey } = istParts(this.now());
    return minutes >= CLOSE_MIN ? dateKey : addDays(dateKey, -1);
  }

  async coverage(symbol) {
    const c = await CandleCoverage.findOne({ symbol }).lean();
    return c ? { from: c.from, to: c.to, ...(c.partial ? { partial: c.partial } : {}) } : null;
  }

  /** Widens what a symbol is saved for; `partial` names a day that is saved only up to now (it stays until a later download completes it). */
  async setCoverage(symbol, { from, to, partial = null }) {
    const have = await this.coverage(symbol);
    const range = have ? { from: from < have.from ? from : have.from, to: to > have.to ? to : have.to } : { from, to };
    const keep = have?.partial && have.partial > this.lastCompleteDay() ? have.partial : null;
    const open = partial ?? keep;
    const next = { ...range, partial: open && open === range.to ? open : null };
    await CandleCoverage.updateOne({ symbol }, { $set: next }, { upsert: true });
    return next;
  }

  /** Saves the complete days found in `candles` (days after the last complete day are left out). Returns how many days were written. */
  async saveCandles(symbol, candles, { live = false } = {}) {
    const last = live ? this.today : this.lastCompleteDay();
    const days = new Map();
    for (const c of candles) {
      const d = dayOf(c.time);
      if (d > last) continue;
      if (!days.has(d)) days.set(d, new Map());
      days.get(d).set(c.time, c);
    }
    const ops = [...days].map(([day, byTime]) => {
      const list = [...byTime.values()].sort((a, b) => a.time - b.time);
      return { updateOne: { filter: { symbol, day }, update: { $set: { count: list.length, data: packCandles(list) } }, upsert: true } };
    });
    if (ops.length) await CandleDay.bulkWrite(ops, { ordered: false });
    return ops.length;
  }

  /** When today's candles were last saved (the newest candle's time of the Nifty), or null when today is not saved. */
  async liveAt(symbol) {
    const doc = await CandleDay.findOne({ symbol, day: this.today }).lean();
    if (!doc) return null;
    const candles = unpackCandles(doc.data.buffer ? Buffer.from(doc.data.buffer) : doc.data, doc.count);
    return candles.at(-1)?.time ?? null;
  }

  /** Candles of the saved days from `fromDay` to `toDay`, oldest first. */
  async read(symbol, fromDay, toDay) {
    const docs = await CandleDay.find({ symbol, day: { $gte: fromDay, $lte: toDay } }).sort({ day: 1 }).lean();
    return docs.flatMap((d) => unpackCandles(d.data.buffer ? Buffer.from(d.data.buffer) : d.data, d.count));
  }

  /** Deletes days older than the retention and pulls the covered range in with them. Returns the number of days deleted. */
  async prune() {
    const oldest = addDays(this.today, -this.retainDays);
    const res = await CandleDay.deleteMany({ day: { $lt: oldest } });
    await CandleCoverage.updateMany({ from: { $lt: oldest } }, { $set: { from: oldest } });
    return res.deletedCount ?? 0;
  }

  /** What is saved: how many symbols and days, the range, and the space used. */
  async summary() {
    const [symbols, first, last, days, size] = await Promise.all([
      CandleCoverage.countDocuments(),
      CandleDay.findOne().sort({ day: 1 }).lean(),
      CandleDay.findOne().sort({ day: -1 }).lean(),
      CandleDay.distinct('day'),
      CandleDay.aggregate([{ $group: { _id: null, bytes: { $sum: { $binarySize: '$data' } }, docs: { $sum: 1 } } }]),
    ]);
    return { symbols, from: first?.day ?? null, to: last?.day ?? null, liveDay: last?.day === this.today ? this.today : null, days: days.length, bytes: size[0]?.bytes ?? 0, records: size[0]?.docs ?? 0, retainDays: this.retainDays };
  }
}
