import { EventEmitter } from 'node:events';

/**
 * Contract every market-data provider implements. Swap brokers by writing a new subclass
 * and registering it in providers/index.js; nothing else in the app talks to a broker directly.
 *
 * Events:
 *   'tick'   (tick: Tick)
 *   'status' ({ connected: boolean, message?: string })
 *
 * Tick shape (all prices in ₹):
 *   { symbol, ltp, open, high, low, prevClose, change, changePct, volume, atp,
 *     totalBuyQty, totalSellQty, depth: { bids: [{price, qty}], asks: [{price, qty}] } | null,
 *     ts (ms epoch), isIndex, source }
 *
 * Candle shape: { time (seconds epoch, bar start), open, high, low, close, volume }
 */
export class BaseProvider extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
  }

  /** Short id shown in the UI, e.g. 'mock' or 'upstox'. */
  get name() {
    throw new Error('not implemented');
  }

  /** True when prices are generated rather than coming from an exchange feed. */
  get isSimulated() {
    return false;
  }

  get capabilities() {
    return { depth: false, history: false, giftNifty: false };
  }

  async connect() {
    throw new Error('not implemented');
  }

  async disconnect() {}

  /** @param {string[]} symbols app symbols (e.g. 'RELIANCE', 'NIFTY 50') */
  async subscribe(_symbols) {
    throw new Error('not implemented');
  }

  /**
   * @param {string} symbol
   * @param {'1m'|'5m'|'15m'} interval
   * @returns {Promise<Array>} candles oldest first
   */
  async getHistory(_symbol, _interval) {
    return [];
  }

  /** About `days` calendar days of `unit`-minute candles for the study. Providers with a real history API override this. */
  async getRangeHistory(symbol, unit, _days) {
    return this.getHistory(symbol, `${unit}m`);
  }

  /** `unit`-minute candles from `fromDay` to `toDay` (YYYY-MM-DD, at most about a month apart), oldest first. Only providers with a real history API have it. */
  async getCandlesBetween(_symbol, _unit, _fromDay, _toDay) {
    throw new Error('This feed has no candle history to save');
  }

  /** Today's `unit`-minute candles so far, oldest first. Throws when the call fails, so a caller knows today was not read. */
  async getTodayCandles(_symbol, _unit) {
    throw new Error('This feed has no candle history to save');
  }

  /** Daily candles for roughly the last `days` calendar days, oldest first; [] when the feed has none. */
  async getDailyHistory(_symbol, _days) {
    return [];
  }

  /** Expiry dates (YYYY-MM-DD, soonest first) of Nifty index options the feed lists; [] when it has none. */
  async getOptionExpiries() {
    return [];
  }

  /**
   * Nifty option contracts for one expiry: [{ symbol, strike, type: 'CE'|'PE', expiry, lotSize }], where `symbol` is the
   * app's own name (see options/symbols.js). Contracts the feed lists become subscribable by that symbol.
   */
  async getOptionContracts(_expiry) {
    return [];
  }

  setStatus(connected, message) {
    this.connected = connected;
    this.emit('status', { connected, message });
  }
}

export const INTERVAL_SECONDS = { '1m': 60, '5m': 300, '15m': 900 };

/** Roll 1-minute candles up to a larger interval. */
export function aggregateCandles(candles, interval) {
  const size = INTERVAL_SECONDS[interval];
  if (!size || size === 60) return candles;
  const out = [];
  for (const c of candles) {
    const bucket = c.time - (c.time % size);
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: bucket });
    }
  }
  return out;
}
