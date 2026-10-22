import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { logger } from '../utils/logger.js';

const MAX_BARS = 2500; // about six sessions of 1-minute bars

/**
 * 1-minute candles for every scanned stock, kept current by folding live ticks into them.
 * History is fetched once per stock and then refreshed slowly in the background, so scanning
 * 50 stocks every minute does not hammer a rate-limited broker API.
 */
export class CandleStore {
  constructor({ market, symbols }) {
    this.market = market;
    this.symbols = symbols;
    this.bars = new Map();
    this.lastVolume = new Map();
    this.cursor = 0;
  }

  get loadedCount() {
    return this.bars.size;
  }

  async load(symbol) {
    const candles = await this.market.getCandles(symbol, '1m');
    this.bars.set(symbol, candles.map((c) => ({ ...c })));
    this.lastVolume.delete(symbol);
  }

  async loadAll() {
    for (const symbol of this.symbols) {
      try {
        await this.load(symbol);
      } catch (err) {
        logger.warn(`Scanner could not load ${symbol} history: ${err.message}`);
      }
    }
  }

  /** Re-read history for a few stocks per call so gaps from feed drops heal over time. */
  async refreshSome(count = 3) {
    for (let i = 0; i < count; i++) {
      const symbol = this.symbols[this.cursor++ % this.symbols.length];
      try {
        await this.load(symbol);
      } catch (err) {
        logger.warn(`Scanner refresh of ${symbol} failed: ${err.message}`);
      }
    }
  }

  onTick(tick) {
    const bars = this.bars.get(tick.symbol);
    if (!bars) return;
    const bucket = Math.floor(tick.ts / 1000 / 60) * 60;
    const prev = this.lastVolume.get(tick.symbol);
    const dv = prev != null && tick.volume != null ? Math.max(0, tick.volume - prev) : 0;
    if (tick.volume != null) this.lastVolume.set(tick.symbol, tick.volume);
    const last = bars.at(-1);
    if (last && bucket < last.time) return; // late tick
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, tick.ltp);
      last.low = Math.min(last.low, tick.ltp);
      last.close = tick.ltp;
      last.volume += dv;
      return;
    }
    bars.push({ time: bucket, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, volume: dv });
    if (bars.length > MAX_BARS) bars.splice(0, bars.length - MAX_BARS);
  }

  /** Candles for `interval`; the last bar is still forming. Null until the stock is loaded. */
  get(symbol, interval = '1m') {
    const bars = this.bars.get(symbol);
    if (!bars) return null;
    return interval === '1m' ? bars : aggregateCandles(bars, interval);
  }
}
