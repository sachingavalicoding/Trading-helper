import mongoose from 'mongoose';
import { unpackCandles } from '../market/historyStore.js';
import { unpackOptionCandles } from '../market/optionHistory.js';
import { unpackRows } from '../ticks/tickRecorder.js';
import { CandleDay } from '../models/CandleDay.js';
import { TickChunk } from '../models/TickChunk.js';
import { DAY_CANDLES, DAY_OPTION_CANDLES } from './seed.js';

// a stored Buffer field comes back as a driver Binary (or a Buffer when mongoose converts it)
const buf = (d) => (Buffer.isBuffer(d) ? d : typeof d?.value === 'function' ? Buffer.from(d.value()) : Buffer.from(d.buffer, d.byteOffset ?? 0, typeof d.position === 'number' ? d.position : undefined));

/** Reads the replay database (see seed.js): the day's recorded seconds and candles, and the earlier days' candles. */
export class MongoSource {
  constructor(day) {
    this.day = day;
  }

  get db() {
    return mongoose.connection.db;
  }

  /** Symbols that have recorded seconds on the day. */
  async tickSymbols() {
    return TickChunk.distinct('symbol', { day: this.day });
  }

  /** Option contracts with saved 1-minute candles on the day (every strike near the day's range, saved that evening). */
  async optionCandleSymbols() {
    return this.db.collection(DAY_OPTION_CANDLES).distinct('symbol', { day: this.day });
  }

  /** First and last recorded second of every symbol that has seconds on the day: Map(symbol -> { first, last }). */
  async tickSpans() {
    const rows = await TickChunk.aggregate([{ $match: { day: this.day } }, { $group: { _id: '$symbol', first: { $min: '$from' }, last: { $max: '$to' } } }]);
    return new Map(rows.map((r) => [r._id, { first: r.first, last: r.last }]));
  }

  /** First second and last second covered by the saved 1-minute candles of every option contract on the day. */
  async optionSpans() {
    const docs = await this.db.collection(DAY_OPTION_CANDLES).find({ day: this.day }).toArray();
    const out = new Map();
    for (const d of docs) {
      const candles = unpackOptionCandles(buf(d.data), d.count);
      if (candles.length) out.set(d.symbol, { first: candles[0].time, last: candles.at(-1).time + 59 });
    }
    return out;
  }

  /** All the day's recorded samples of a symbol, oldest first. */
  async readTicks(symbol) {
    const chunks = await TickChunk.find({ symbol, day: this.day }).sort({ from: 1 }).lean();
    return chunks.flatMap((c) => unpackRows(buf(c.data), c.count));
  }

  /** The day's 1-minute candles of a symbol (a share, or an option contract), oldest first. */
  async readDayCandles(symbol) {
    const doc = await this.db.collection(DAY_CANDLES).findOne({ symbol, day: this.day });
    if (doc) return unpackCandles(buf(doc.data), doc.count);
    const opt = await this.db.collection(DAY_OPTION_CANDLES).findOne({ symbol, day: this.day });
    return opt ? unpackOptionCandles(buf(opt.data), opt.count) : [];
  }

  /** The 1-minute candles of the saved days before the replay day, from `fromDay`, oldest first. */
  async readPrior(symbol, fromDay) {
    const docs = await CandleDay.find({ symbol, day: { $gte: fromDay, $lt: this.day } }).sort({ day: 1 }).lean();
    return docs.flatMap((d) => unpackCandles(buf(d.data), d.count));
  }
}
