import { OptionCandleDay } from '../models/OptionCandleDay.js';
import { unpackOptionCandles } from '../market/optionHistory.js';

// The saved real option premiums as a lookup for the study: for a day, which expiries were saved, and for a contract (expiry, strike, CE or PE)
// its 1-minute candles by time. A study that uses it prices a trade from the contract's own candles and takes only the trades whose
// contract was saved on that day.

const keyOf = (expiry, strike, type) => `${expiry}|${strike}|${type}`;

/**
 * The first day of a study that uses the saved real prices. `saved` is the saved days, oldest first. The days asked for count back from the
 * newest saved day (10 = the last 10 saved days); a first date asked for wins when it is later; with neither, everything saved.
 */
export function firstStudyDay(saved, { days = null, from = null } = {}) {
  if (!saved.length) return null;
  const byCount = days && !from ? saved.at(-Math.min(days, saved.length)) : null;
  return [saved[0], from, byCount].filter(Boolean).sort().at(-1);
}

export class PriceBook {
  /** @param byDay  Map day -> Map(`${expiry}|${strike}|${type}` -> Map(time -> candle)) */
  constructor(byDay = new Map()) {
    this.byDay = byDay;
    this.stats = { used: 0, noPrice: 0 }; // trades priced from saved candles / entries skipped because their contract was not saved
  }

  /** Builds the book from [{ day, expiry, strike, type, candles }]. */
  static fromContracts(list) {
    const byDay = new Map();
    for (const { day, expiry, strike, type, candles } of list) {
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day).set(keyOf(expiry, strike, type), new Map(candles.map((c) => [c.time, c])));
    }
    return new PriceBook(byDay);
  }

  /** Reads what is saved for an index, optionally between two days. */
  static async load(index, { from, to } = {}) {
    const filter = { index };
    if (from || to) filter.day = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const docs = await OptionCandleDay.find(filter).lean();
    return PriceBook.fromContracts(
      docs.map((d) => ({ day: d.day, expiry: d.expiry, strike: d.strike, type: d.type, candles: unpackOptionCandles(d.data.buffer ? Buffer.from(d.data.buffer) : d.data, d.count) })),
    );
  }

  /** The days with saved prices, oldest first. */
  get days() {
    return [...this.byDay.keys()].sort();
  }

  hasDay(day) {
    return this.byDay.has(day);
  }

  /** The expiries saved on a day, soonest first. */
  expiries(day) {
    const set = new Set();
    for (const key of this.byDay.get(day)?.keys() ?? []) set.add(key.split('|')[0]);
    return [...set].sort();
  }

  /** Every saved contract of one expiry on a day: [{ strike, type, candles: Map(time -> candle) }], by strike. */
  chain(day, expiry) {
    const out = [];
    for (const [key, candles] of this.byDay.get(day) ?? []) {
      const [e, strike, type] = key.split('|');
      if (e === expiry) out.push({ strike: Number(strike), type, candles });
    }
    return out.sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
  }

  /** Adds (or replaces) one contract's candles of a day: the live option chain fills today's page this way. */
  put(day, expiry, strike, type, candles) {
    if (!this.byDay.has(day)) this.byDay.set(day, new Map());
    this.byDay.get(day).set(keyOf(expiry, strike, type), new Map(candles.map((c) => [c.time, c])));
  }

  /** The candles of one contract on a day as a Map(time -> candle), or null when it was not saved. */
  contract(day, expiry, strike, type) {
    return this.byDay.get(day)?.get(keyOf(expiry, strike, type)) ?? null;
  }

  /** What a study says about the prices it used. */
  describe() {
    const days = this.days;
    return { mode: 'real', days: days.length, from: days[0] ?? null, to: days.at(-1) ?? null, priced: this.stats.used, skipped: this.stats.noPrice };
  }
}
