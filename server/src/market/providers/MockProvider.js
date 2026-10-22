import { BaseProvider, aggregateCandles } from './BaseProvider.js';
import { NIFTY50, INDICES, isIndex } from '../instruments.js';
import { roundToTick, round2 } from '../../utils/money.js';

const HISTORY_BARS = 375; // one full NSE session of 1-minute bars

// Box-Muller standard normal.
const gauss = () => {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
};

/**
 * Simulated feed for development and for practising when NSE is closed.
 * Every number it produces is synthetic and the UI labels it SIMULATED.
 */
export class MockProvider extends BaseProvider {
  constructor({ intervalMs = 1000, now = () => Date.now() } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.now = now;
    this.state = new Map();
    this.timer = null;
  }

  get name() {
    return 'mock';
  }

  get isSimulated() {
    return true;
  }

  get capabilities() {
    return { depth: true, history: true, giftNifty: false };
  }

  async connect() {
    for (const inst of [...NIFTY50, ...INDICES]) this.#init(inst);
    this.timer = setInterval(() => this.#step(), this.intervalMs);
    this.timer.unref?.();
    this.setStatus(true, 'Simulated feed running');
  }

  async disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.setStatus(false, 'Simulated feed stopped');
  }

  async subscribe() {
    // The mock feed always streams every instrument.
  }

  async getHistory(symbol, interval = '1m') {
    const s = this.state.get(symbol);
    if (!s) return [];
    return aggregateCandles(s.bars.map((b) => ({ ...b })), interval);
  }

  /** Test helper: force a price and emit a tick immediately. */
  setPrice(symbol, price) {
    const s = this.state.get(symbol);
    if (!s) throw new Error(`unknown symbol ${symbol}`);
    this.#apply(s, price, 0);
    this.emit('tick', this.#tick(s));
  }

  getLastTick(symbol) {
    const s = this.state.get(symbol);
    return s ? this.#tick(s) : null;
  }

  #init(inst) {
    const index = isIndex(inst.symbol);
    const vol = index ? 0.00035 : 0.0007; // per-minute volatility for history
    const prevClose = inst.seed;
    const nowSec = Math.floor(this.now() / 1000);
    const start = nowSec - (nowSec % 60) - (HISTORY_BARS - 1) * 60;
    const bars = [];
    let price = prevClose * (1 + gauss() * 0.004);
    const open = roundToTick(price);
    let high = open;
    let low = open;
    let volume = 0;
    for (let i = 0; i < HISTORY_BARS; i++) {
      const o = price;
      const steps = [o];
      for (let k = 0; k < 4; k++) {
        price = price * (1 + gauss() * vol * 0.5 + (prevClose - price) / prevClose * 0.002);
        steps.push(price);
      }
      const v = index ? 0 : Math.round((20000 + Math.random() * 80000) * (1500 / Math.max(inst.seed, 100)));
      const bar = {
        time: start + i * 60,
        open: roundToTick(o),
        high: roundToTick(Math.max(...steps)),
        low: roundToTick(Math.min(...steps)),
        close: roundToTick(price),
        volume: v,
      };
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      volume += v;
      bars.push(bar);
    }
    const s = {
      symbol: inst.symbol,
      index,
      prevClose,
      open,
      high,
      low,
      ltp: bars.at(-1).close,
      volume,
      turnover: bars.reduce((t, b) => t + ((b.high + b.low + b.close) / 3) * b.volume, 0),
      bars,
      // Order book imbalance drifts slowly so the buy/sell pressure bar moves believably.
      imbalance: 0.5,
    };
    this.state.set(inst.symbol, s);
  }

  #apply(s, price, qty) {
    s.ltp = roundToTick(price);
    s.high = Math.max(s.high, s.ltp);
    s.low = Math.min(s.low, s.ltp);
    s.volume += qty;
    s.turnover += s.ltp * qty;
    const nowSec = Math.floor(this.now() / 1000);
    const barTime = nowSec - (nowSec % 60);
    const last = s.bars.at(-1);
    if (last && last.time === barTime) {
      last.high = Math.max(last.high, s.ltp);
      last.low = Math.min(last.low, s.ltp);
      last.close = s.ltp;
      last.volume += qty;
    } else {
      s.bars.push({ time: barTime, open: s.ltp, high: s.ltp, low: s.ltp, close: s.ltp, volume: qty });
      if (s.bars.length > HISTORY_BARS * 2) s.bars.splice(0, s.bars.length - HISTORY_BARS * 2);
    }
  }

  #step() {
    for (const s of this.state.values()) {
      if (Math.random() < 0.35) continue; // not every instrument trades every second
      s.imbalance = Math.min(0.8, Math.max(0.2, s.imbalance + gauss() * 0.03));
      const drift = (s.imbalance - 0.5) * 0.0002;
      const sigma = s.index ? 0.00012 : 0.00025;
      const next = s.ltp * (1 + drift + gauss() * sigma);
      const qty = s.index ? 0 : Math.max(1, Math.round(Math.random() * 400 * (1500 / Math.max(s.prevClose, 100))));
      this.#apply(s, next, qty);
      this.emit('tick', this.#tick(s));
    }
  }

  #depth(s) {
    if (s.index) return null;
    const bids = [];
    const asks = [];
    const base = 1500 / Math.max(s.prevClose, 50);
    for (let i = 0; i < 5; i++) {
      bids.push({ price: roundToTick(s.ltp - 0.05 * (i + 1)), qty: Math.round((50 + Math.random() * 600) * base * s.imbalance * 2) + 1 });
      asks.push({ price: roundToTick(s.ltp + 0.05 * (i + 1)), qty: Math.round((50 + Math.random() * 600) * base * (1 - s.imbalance) * 2) + 1 });
    }
    return { bids, asks };
  }

  #tick(s) {
    const change = round2(s.ltp - s.prevClose);
    const depthScale = Math.round(s.volume * 0.15);
    return {
      symbol: s.symbol,
      ltp: s.ltp,
      open: s.open,
      high: s.high,
      low: s.low,
      prevClose: s.prevClose,
      change,
      changePct: round2((change / s.prevClose) * 100),
      volume: s.volume,
      atp: s.volume ? round2(s.turnover / s.volume) : null,
      totalBuyQty: s.index ? null : Math.round(depthScale * s.imbalance),
      totalSellQty: s.index ? null : Math.round(depthScale * (1 - s.imbalance)),
      depth: this.#depth(s),
      ts: this.now(),
      isIndex: s.index,
      source: 'mock',
    };
  }
}
