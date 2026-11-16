// @ts-check
import { istParts } from '../market/marketHours.js';
import { PriceBook } from '../study/priceBook.js';
import { optionSeries } from '../combos/optionData.js';
import { CONDITION_BY_KEY } from '../combos/conditions.js';
import { INDEXES, chooseExpiry } from './symbols.js';
import { logger } from '../utils/logger.js';

// The option chain as the live trader sees it, so a combination with an options check (PCR, OI change, max pain, IV percentile, delta,
// theta; combos/conditions.js) can buy live as it did in the study. During the day it reads today's 1-minute candles (with open interest)
// of the strikes near the money from the broker, at most every few minutes and only while some switched-on combination needs them, and
// puts them beside the saved earlier days (for the IV percentile). Nothing is read on the sample feed.

export const REFRESH_MS = 4 * 60_000;
export const STRIKES_EACH_SIDE = 6; // 13 strikes x calls and puts, for the nearest expiry and the one the trader buys
const PAST_MS = 6 * 3600_000; // the saved earlier days are read again after this long (they change once an evening)
const WAIT_MS = 8000;

/** Whether a check needs the option chain. */
export const needsChain = (/** @type {string} */ key) => CONDITION_BY_KEY.get(key)?.needs === 'options';

/** Whether any switched-on combination uses an options check. */
export const combosNeedChain = (/** @type {any[]} */ combos) => (combos ?? []).some((c) => c.on !== false && [...(c.conds ?? []), ...(c.also ?? [])].some(needsChain));

export class LiveChain {
  /**
   * @param {{ market: any, now?: () => Date, loadPast?: (index: string) => Promise<PriceBook>, strikesEachSide?: number }} o
   */
  constructor({ market, now = () => new Date(), loadPast = (index) => PriceBook.load(index), strikesEachSide = STRIKES_EACH_SIDE }) {
    this.market = market;
    this.now = now;
    this.loadPast = loadPast;
    this.strikesEachSide = strikesEachSide;
    /** @type {Map<string, { book: PriceBook, at: number, pastAt: number, day: string, version: number, running: Promise<void> | null, rows: Map<string, any[]> }>} */
    this.state = new Map();
    /** @type {Map<string, { key: string, series: any }>} */
    this.series = new Map();
  }

  #entry(/** @type {string} */ index) {
    let e = this.state.get(index);
    if (!e) {
      e = { book: new PriceBook(), at: 0, pastAt: 0, day: '', version: 0, running: null, rows: new Map() };
      this.state.set(index, e);
    }
    return e;
  }

  /** Reads the chain again when it is older than REFRESH_MS (one read at a time per index). Resolves when that read is done. */
  refresh(/** @type {string} */ index, /** @type {number} */ spot) {
    const provider = this.market?.provider;
    if (!provider || provider.isSimulated || !(spot > 0)) return Promise.resolve();
    const e = this.#entry(index);
    if (e.running) return e.running;
    if (Date.now() - e.at < REFRESH_MS) return Promise.resolve();
    e.running = this.#read(index, spot, e)
      .catch((err) => {
        logger.warn(`live option chain (${index}) failed: ${err.message}`);
      })
      .finally(() => {
        e.running = null;
        e.at = Date.now();
      });
    return e.running;
  }

  async #read(/** @type {string} */ index, /** @type {number} */ spot, /** @type {any} */ e) {
    const provider = this.market.provider;
    const today = istParts(this.now()).dateKey;
    if (e.day !== today || Date.now() - e.pastAt > PAST_MS) {
      const past = await this.loadPast(index);
      past.byDay.delete(today);
      e.book = past;
      e.pastAt = Date.now();
      e.day = today;
      e.rows.clear();
    }
    const step = INDEXES[index]?.strikeStep ?? 50;
    const expiries = (await provider.getOptionExpiries(index)).filter((/** @type {string} */ x) => x >= today).sort();
    const bought = chooseExpiry(expiries, this.now(), { minDays: 1 });
    const wanted = [...new Set([expiries[0], bought].filter(Boolean))];
    const atm = Math.round(spot / step) * step;
    const lo = atm - this.strikesEachSide * step;
    const hi = atm + this.strikesEachSide * step;
    for (const expiry of wanted) {
      if (!e.rows.has(expiry)) e.rows.set(expiry, await provider.getOptionContracts(expiry, index));
      for (const row of e.rows.get(expiry).filter((/** @type {any} */ r) => r.strike >= lo && r.strike <= hi)) {
        const candles = (await provider.getTodayOptionCandles(row.symbol, 1)).filter((/** @type {any} */ c) => istParts(new Date(c.time * 1000)).dateKey === today);
        if (candles.length) e.book.put(today, expiry, row.strike, row.type, candles);
      }
    }
    e.version += 1;
  }

  /**
   * The option-chain series for a live chart, or null when none is known yet. With `need`, a read is started when the chain is stale,
   * and waited for (up to a few seconds) so the bar that just closed is read with fresh open interest.
   * @param {string} index
   * @param {{ time: number, close: number }[]} bars
   * @param {{ need?: boolean, wait?: boolean }} [o]
   */
  async seriesFor(index, bars, { need = false, wait = true } = {}) {
    const newest = bars[bars.length - 1];
    if (!newest) return null;
    if (need) {
      const read = this.refresh(index, newest.close);
      if (wait) await Promise.race([read, new Promise((resolve) => setTimeout(resolve, WAIT_MS).unref?.())]);
    }
    const e = this.state.get(index);
    if (!e || !e.book.days.length) return null;
    const key = `${e.version}|${bars.length}|${newest.time}|${newest.close}`;
    const kept = this.series.get(index);
    if (kept?.key === key) return kept.series;
    const series = optionSeries(bars, e.book, { strikeStep: INDEXES[index]?.strikeStep ?? 50 });
    this.series.set(index, { key, series });
    return series;
  }
}
