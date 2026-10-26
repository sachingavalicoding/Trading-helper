import { EventEmitter } from 'node:events';
import { NIFTY50 } from '../market/instruments.js';
import { istParts, isTradingDay, SQUARE_OFF_MIN } from '../market/marketHours.js';
import { ScanIdea } from '../models/index.js';
import { logger } from '../utils/logger.js';
import { CandleStore } from './candleStore.js';
import { evaluateStock, MIN_SCORE } from './evaluate.js';
import { buildPlan } from './plan.js';

const PLAN_AT_MIN = 9 * 60; // the morning plan goes out at 09:00 IST
const IDEA_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_WATCHING = 6;
const STATUS_ORDER = { ENTRY: 0, WATCHING: 1 };
const MAX_REJECTED = 12;
const MAX_IDEAS_PER_STOCK = 2; // per day: a stock that keeps failing is not worth another try
const LATE_R = 0.5; // price already ran this far (in risk units) towards the target
const ADVERSE_R = 0.3; // price already slid this far towards the stop

/**
 * Looks at all 50 Nifty stocks every minute and keeps a short ranked list of ideas.
 * Events: 'entry' (idea) when a new idea is raised, 'closed' (idea) when one reaches its
 * target, stop loss or expiry, 'plan' (plan) once on each trading day from 09:00 IST.
 */
export class ScannerService extends EventEmitter {
  constructor({ market, config, news = null, now = () => new Date(), intervalMs = 15_000 }) {
    super();
    this.news = news; // optional NewsService; the scanner works without it
    this.market = market;
    this.config = config;
    this.now = now;
    this.intervalMs = intervalMs;
    this.symbols = NIFTY50.map((s) => s.symbol);
    this.store = new CandleStore({ market, symbols: this.symbols });
    this.open = new Map(); // symbol -> open idea docs
    this.raisedToday = new Set(); // `${day}|${symbol}|${setup}|${side}`
    this.perStock = new Map(); // symbol -> { count, stopped } for today
    this.perStockDay = null;
    this.result = { items: [], rejected: [], scanned: 0, total: this.symbols.length, updatedAt: null };
    this.scanning = false;
    this.warm = null;
    this.planSentOn = null;
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
    for (const idea of await ScanIdea.find({ day: this.day }, 'day symbol setup side status').lean()) {
      this.raisedToday.add(this.#key(idea));
      const st = this.#stockToday(idea.symbol);
      st.count += 1;
      if (idea.status === 'STOPPED') st.stopped = true;
    }
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
        .refreshSome(1)
        .then(() => this.scanOnce())
        .then(() => this.announcePlan())
        .catch((e) => logger.error('scan failed', e));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.market.off('tick', this.onTick);
  }

  #stockToday(symbol) {
    if (this.perStockDay !== this.day) {
      this.perStock = new Map();
      this.perStockDay = this.day;
    }
    if (!this.perStock.has(symbol)) this.perStock.set(symbol, { count: 0, stopped: false });
    return this.perStock.get(symbol);
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
    if (status === 'STOPPED') this.#stockToday(idea.symbol).stopped = true;
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
      this.#stockToday(c.symbol).count += 1;
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
    const movedR = risk ? Math.round(((d * (tick.ltp - idea.entry)) / risk) * 100) / 100 : 0;
    let lateReason = null;
    if (movedR > LATE_R) lateReason = `Price already ran ${movedR}R past the entry. Too late to enter.`;
    else if (movedR < -ADVERSE_R) lateReason = `Price has slid ${Math.abs(movedR)}R towards the stop. The setup is weakening.`;
    return {
      ...idea.card,
      canEnter: !lateReason,
      lateReason,
      status: 'ENTRY',
      symbol: idea.symbol,
      ltp: tick.ltp,
      changePct: tick.changePct,
      openedAt: idea.createdAt,
      movedR,
      ideaId: String(idea._id),
    };
  }

  /** News verdicts, re-read at most every 30 seconds so a fast scan does not hit the database every time. */
  async #newsSignals() {
    const t = this.now().getTime();
    if (this.newsCache && t - this.newsCache.at < 30_000) return this.newsCache.value;
    const value = (await this.news?.signals().catch((e) => (logger.warn(`news unavailable: ${e.message}`), {}))) ?? {};
    this.newsCache = { at: t, value };
    return value;
  }

  async scanOnce() {
    if (this.scanning) return this.result;
    this.scanning = true;
    try {
      const enforceWindows = Boolean(this.config.enforceMarketHours);
      const niftyChangePct = this.market.getTick('NIFTY 50')?.changePct ?? null;
      const newsBySymbol = await this.#newsSignals();
      const entries = [];
      const watching = [];
      const rejected = [];
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
        const { candidates } = evaluateStock({ symbol, tick, c1, niftyChangePct, news: newsBySymbol[symbol] ?? null }, { now: this.now(), enforceWindows });
        const st = this.#stockToday(symbol);
        const strong = candidates.filter((c) => c.score >= MIN_SCORE);
        const stockBlock = st.stopped ? 'Already stopped out on this stock today' : st.count >= MAX_IDEAS_PER_STOCK ? `Already had ${st.count} ideas on this stock today` : null;
        const ok = stockBlock ? null : strong.find((c) => c.status !== 'MISSED' && !c.blocked.length);
        if (ok) {
          const item = { ...ok, symbol, ltp: tick.ltp, changePct: tick.changePct };
          if (ok.status === 'ENTRY') {
            const idea = await this.raise(item);
            if (idea) entries.push(this.#ideaItem(idea, tick));
          } else watching.push(item);
          continue;
        }
        // The best idea was turned down: keep it so the screen can say why.
        const top = strong[0];
        if (top) {
          const reasons = [...(stockBlock ? [stockBlock] : []), ...(top.status === 'MISSED' ? ['Price already ran past the entry zone. Do not chase it.'] : []), ...top.blocked];
          rejected.push({ symbol, side: top.side, setup: top.setup, score: top.score, status: top.status, entry: top.entry, stopLoss: top.stopLoss, target1: top.target1, trigger: top.trigger, ltp: tick.ltp, changePct: tick.changePct, reasons });
        }
      }
      // An open idea that price has run away from can no longer be entered: take it off the main list.
      const stale = entries.filter((i) => i.canEnter === false);
      for (const i of stale) {
        rejected.push({ symbol: i.symbol, side: i.side, setup: i.setup, score: i.score, status: 'LATE', entry: i.entry, stopLoss: i.stopLoss, target1: i.target1, ltp: i.ltp, changePct: i.changePct, reasons: [i.lateReason] });
      }
      const live = entries.filter((i) => i.canEnter !== false);
      const byScore = (a, b) => b.score - a.score;
      watching.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byScore(a, b));
      this.result = {
        items: [...live.sort(byScore), ...watching.slice(0, MAX_WATCHING)],
        rejected: rejected.sort(byScore).slice(0, MAX_REJECTED),
        scanned,
        total: this.symbols.length,
        updatedAt: this.now().toISOString(),
      };
      return this.result;
    } finally {
      this.scanning = false;
    }
  }

  /** Today's pre-market plan (see plan.js). */
  async plan() {
    const signals = (await this.news?.signals().catch(() => ({}))) ?? {};
    return buildPlan({ store: this.store, market: this.market, signals, now: this.now() });
  }

  /** Emit 'plan' once per trading day, at or after 09:00 IST. */
  async announcePlan() {
    const now = this.now();
    const { dateKey, minutes } = istParts(now);
    if (this.planSentOn === dateKey || minutes < PLAN_AT_MIN || !isTradingDay(now, this.config.nseHolidays)) return null;
    this.planSentOn = dateKey;
    const plan = await this.plan();
    this.emit('plan', plan);
    return plan;
  }

  /** Ideas that finished today (target, stop loss or expiry), newest first. */
  async doneToday() {
    return ScanIdea.find({ day: this.day, status: { $ne: 'OPEN' } })
      .sort({ closedAt: -1 })
      .limit(20)
      .lean();
  }
}
