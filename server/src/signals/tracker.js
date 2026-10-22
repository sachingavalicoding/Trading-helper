import { Signal } from '../models/index.js';
import { round2 } from '../utils/money.js';
import { logger } from '../utils/logger.js';

const SIGNAL_TTL_MS = 2 * 60 * 60 * 1000; // intraday ideas: give up after two hours

/** Watches ticks and closes open signals when price reaches the target or the stop loss. */
export class SignalTracker {
  constructor({ market, now = () => new Date() }) {
    this.market = market;
    this.now = now;
    this.open = new Map(); // symbol -> signal docs
    this.onTick = (tick) => this.#check(tick).catch((e) => logger.error('signal check failed', e));
  }

  async init() {
    for (const s of await Signal.find({ status: 'OPEN' }).lean()) this.#add(s);
    this.market.on('tick', this.onTick);
  }

  stop() {
    this.market.off('tick', this.onTick);
  }

  #add(s) {
    if (!this.open.has(s.symbol)) this.open.set(s.symbol, []);
    this.open.get(s.symbol).push(s);
  }

  /** Log a BUY/SELL signal once per user and stock while an earlier one is still open. */
  async record(userId, sig) {
    const existing = this.open.get(sig.symbol)?.find((s) => String(s.user) === String(userId) && s.action === sig.action);
    if (existing) return existing;
    const doc = await Signal.create({
      user: userId,
      symbol: sig.symbol,
      action: sig.action,
      entry: sig.ltp,
      stopLoss: sig.plan.stopLoss,
      target: sig.plan.target,
      riskReward: sig.plan.riskReward,
      score: sig.score,
    });
    const s = doc.toObject();
    this.#add(s);
    return s;
  }

  async #check({ symbol, ltp }) {
    const list = this.open.get(symbol);
    if (!list?.length) return;
    const now = this.now();
    const keep = [];
    for (const s of list) {
      const long = s.action === 'BUY';
      let status = null;
      if (long ? ltp >= s.target : ltp <= s.target) status = 'TARGET_HIT';
      else if (long ? ltp <= s.stopLoss : ltp >= s.stopLoss) status = 'SL_HIT';
      else if (now - new Date(s.createdAt) > SIGNAL_TTL_MS) status = 'EXPIRED';
      if (!status) {
        keep.push(s);
        continue;
      }
      await Signal.updateOne({ _id: s._id, status: 'OPEN' }, { status, exitPrice: ltp, closedAt: now });
    }
    if (keep.length) this.open.set(symbol, keep);
    else this.open.delete(symbol);
  }
}

/** Hit rate and recent history for the dashboard. */
export async function signalStats(userId) {
  const all = await Signal.find({ user: userId }).sort({ createdAt: -1 }).limit(200).lean();
  const count = (st) => all.filter((s) => s.status === st).length;
  const wins = count('TARGET_HIT');
  const losses = count('SL_HIT');
  const pct = (s) => {
    if (s.exitPrice == null) return null;
    return round2(((s.exitPrice - s.entry) / s.entry) * 100 * (s.action === 'BUY' ? 1 : -1));
  };
  return {
    total: all.length,
    open: count('OPEN'),
    wins,
    losses,
    expired: count('EXPIRED'),
    hitRate: wins + losses ? round2((wins / (wins + losses)) * 100) : null,
    recent: all.slice(0, 10).map((s) => ({ ...s, movePct: pct(s) })),
  };
}
