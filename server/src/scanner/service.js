import { EventEmitter } from 'node:events';
import { NIFTY50 } from '../market/instruments.js';
import { istParts, SQUARE_OFF_MIN } from '../market/marketHours.js';
import { ScanIdea } from '../models/index.js';
import { logger } from '../utils/logger.js';
import { CandleStore } from './candleStore.js';
import { evaluateStock, MIN_SCORE } from './evaluate.js';

const IDEA_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_WATCHING = 6;
const STATUS_ORDER = { ENTRY: 0, WATCHING: 1, MISSED: 2 };

/**
 * Looks at all 50 Nifty stocks every minute and keeps a short ranked list of ideas.
 * Events: 'entry' (idea) when a new idea is raised, 'closed' (idea) when one reaches its
 * target, stop loss or expiry.
 */
export class ScannerService extends EventEmitter {
  constructor({ market, config, now = () => new Date(), intervalMs = 60_000 }) {
    super();
    this.market = market;
    this.config = config;
    this.now = now;
    this.intervalMs = intervalMs;
    this.symbols = NIFTY50.map((s) => s.symbol);
    this.store = new CandleStore({ market, symbols: this.symbols });
    this.open = new Map(); // symbol -> open idea docs
    this.raisedToday = new Set(); // `${day}|${symbol}|${setup}|${side}`
    this.result = { items: [], scanned: 0, total: this.symbols.length, updatedAt: null };
    this.scanning = false;
    this.warm = null;
    this.onTick = (tick) => {
      this.store.onTick(tick);
      this.#check(tick).catch((e) => logger.error('scanner tick check failed', e));
    };
  }

  get day() {
    return istParts(this.now()).dateKey;
  }

  async init() {
    for (const idea of await ScanIdea.find({ status: 'OPEN' }).lean()) this.#track(idea);
    for (const idea of await ScanIdea.find({ day: this.day }, 'day symbol setup side').lean()) this.raisedToday.add(this.#key(idea));
    this.market.on('tick', this.onTick);
  }

  /** Load history for every stock in the background; the screen shows progress meanwhile. */
  warmUp() {
    this.warm ||= this.store.loadAll().then(() => logger.info(`Scanner ready: ${this.store.loadedCount} stocks loaded`));
    return this.warm;
  }

  start() {
    this.warmUp()
      .then(() => this.scanOnce())
      .catch((e) => logger.error('scanner warm-up failed', e));
    this.timer = setInterval(() => {
      this.store
        .refreshSome(3)
        .then(() => this.scanOnce())
        .catch((e) => logger.error('scan failed', e));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.market.off('tick', this.onTick);
  }

  #key(idea) {
    return `${idea.day}|${idea.symbol}|${idea.setup}|${idea.side}`;
  }

  #track(idea) {
    if (!this.open.has(idea.symbol)) this.open.set(idea.symbol, []);
    this.open.get(idea.symbol).push(idea);
  }

  #expired(idea) {
    const now = this.now();
    if (now - new Date(idea.createdAt) > IDEA_TTL_MS) return true;
    return this.config.enforceMarketHours && istParts(now).minutes >= SQUARE_OFF_MIN;
  }

  async #close(idea, status, price) {
    const closedAt = this.now();
    const res = await ScanIdea.updateOne({ _id: idea._id, status: 'OPEN' }, { status, exitPrice: price, closedAt });
    if (!res.modifiedCount) return;
    const list = (this.open.get(idea.symbol) || []).filter((i) => String(i._id) !== String(idea._id));
    if (list.length) this.open.set(idea.symbol, list);
    else this.open.delete(idea.symbol);
    // Take it off the screen now rather than at the next scan.
    this.result = { ...this.result, items: this.result.items.filter((i) => i.ideaId !== String(idea._id)) };
    this.emit('closed', { ...idea, status, exitPrice: price, closedAt });
  }

  async #check({ symbol, ltp }) {
    for (const idea of [...(this.open.get(symbol) || [])]) {
      const long = idea.side === 'BUY';
      if (long ? ltp >= idea.target1 : ltp <= idea.target1) await this.#close(idea, 'TARGET_HIT', ltp);
      else if (long ? ltp <= idea.stopLoss : ltp >= idea.stopLoss) await this.#close(idea, 'STOPPED', ltp);
      else if (this.#expired(idea)) await this.#close(idea, 'EXPIRED', ltp);
    }
  }

  /**
   * Raise a new idea from a candidate with status ENTRY, freezing its plan.
   * Returns null when this stock, setup and side already had an idea today.
   */
  async raise(c) {
    const day = this.day;
    const key = `${day}|${c.symbol}|${c.setup}|${c.side}`;
    if (this.raisedToday.has(key)) return null;
    this.raisedToday.add(key);
    try {
      const doc = await ScanIdea.create({
        day,
        symbol: c.symbol,
        setup: c.setup,
        side: c.side,
        entry: c.entry,
        stopLoss: c.stopLoss,
        target1: c.target1,
        target2: c.target2,
        riskReward: c.riskReward,
        score: c.score,
        card: c,
      });
      const idea = doc.toObject();
      this.#track(idea);
      this.emit('entry', idea);
      return idea;
    } catch (err) {
      if (err.code === 11000) return null;
      this.raisedToday.delete(key);
      throw err;
    }
  }

  /** The frozen plan of an open idea, with the live price and how far it has run in risk units. */
  #ideaItem(idea, tick) {
    const d = idea.side === 'BUY' ? 1 : -1;
    const risk = Math.abs(idea.entry - idea.stopLoss);
    return {
      ...idea.card,
      status: 'ENTRY',
      symbol: idea.symbol,
      ltp: tick.ltp,
      changePct: tick.changePct,
      openedAt: idea.createdAt,
      movedR: risk ? Math.round(((d * (tick.ltp - idea.entry)) / risk) * 100) / 100 : 0,
      ideaId: String(idea._id),
    };
  }

  async scanOnce() {
    if (this.scanning) return this.result;
    this.scanning = true;
    try {
      const enforceWindows = Boolean(this.config.enforceMarketHours);
      const niftyChangePct = this.market.getTick('NIFTY 50')?.changePct ?? null;
      const entries = [];
      const watching = [];
      let scanned = 0;
      for (const symbol of this.symbols) {
        const c1 = this.store.get(symbol);
        const tick = this.market.getTick(symbol);
        if (!c1 || !tick) continue;
        scanned++;
        for (const idea of [...(this.open.get(symbol) || [])]) {
          if (this.#expired(idea)) await this.#close(idea, 'EXPIRED', tick.ltp);
        }
        const open = this.open.get(symbol);
        if (open?.length) {
          for (const idea of open) entries.push(this.#ideaItem(idea, tick));
          continue;
        }
        const { candidates } = evaluateStock({ symbol, tick, c1, niftyChangePct }, { now: this.now(), enforceWindows });
        const top = candidates.find((c) => c.score >= MIN_SCORE);
        if (!top) continue;
        const item = { ...top, symbol, ltp: tick.ltp, changePct: tick.changePct };
        if (top.status === 'ENTRY') {
          const idea = await this.raise(item);
          if (idea) entries.push(this.#ideaItem(idea, tick));
        } else watching.push(item);
      }
      const byScore = (a, b) => b.score - a.score;
      watching.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byScore(a, b));
      this.result = {
        items: [...entries.sort(byScore), ...watching.slice(0, MAX_WATCHING)],
        scanned,
        total: this.symbols.length,
        updatedAt: this.now().toISOString(),
      };
      return this.result;
    } finally {
      this.scanning = false;
    }
  }

  /** Ideas that finished today (target, stop loss or expiry), newest first. */
  async doneToday() {
    return ScanIdea.find({ day: this.day, status: { $ne: 'OPEN' } })
      .sort({ closedAt: -1 })
      .limit(20)
      .lean();
  }
}
