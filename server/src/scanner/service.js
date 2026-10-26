import { EventEmitter } from 'node:events';
import { NIFTY50 } from '../market/instruments.js';
import { istParts, isTradingDay, SQUARE_OFF_MIN } from '../market/marketHours.js';
import { ScanIdea } from '../models/index.js';
import { logger } from '../utils/logger.js';
import { CandleStore } from './candleStore.js';
import { evaluateStock, MIN_SCORE } from './evaluate.js';
import { buildPlan } from './plan.js';
import { resultR } from './stats.js';
import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { ema, sessionVwap } from '../signals/indicators.js';

const PLAN_AT_MIN = 9 * 60; // the morning plan goes out at 09:00 IST
const IDEA_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_WATCHING = 6;
const STATUS_ORDER = { ENTRY: 0, WATCHING: 1 };
const MAX_REJECTED = 12;
const SETUP_SAMPLE = 20; // the last 20 finished ideas of a setup...
const SETUP_MIN_AVG_R = -0.25; // ...averaging worse than this switch the setup off
const SETUP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // only recent ideas count, so a switched-off setup comes back by itself
const MARKET_STATE_MS = 60_000;
const MAX_OPEN_IDEAS = 5; // more at once cannot all be watched, so the extra ones wait
const MAX_IDEAS_PER_STOCK = 2; // per day: a stock that keeps failing is not worth another try
const LATE_R = 0.5; // price already ran this far (in risk units) towards the target
const CHOP_WINDOW = 4; // of the last 4 finished ideas...
const CHOP_STOPS = 3; // ...this many stopped out means the market is choppy
const CHOP_PAUSE_MS = 45 * 60 * 1000;
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
    this.daily = new Map(); // symbol -> about a month of daily candles
    this.dailyDay = null;
    this.disabledSetups = new Map(); // setup -> why it is off
    this.setupCheckedAt = 0;
    this.marketStateAt = 0;
    this.marketState = null;
    this.finished = []; // today's finished ideas, oldest first: { status, at }
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
    for (const i of await ScanIdea.find({ day: this.day, status: { $ne: 'OPEN' }, closedAt: { $ne: null } }, 'status closedAt').sort({ closedAt: 1 }).lean()) this.finished.push({ status: i.status, at: new Date(i.closedAt) });
    this.market.on('tick', this.onTick);
  }

  /** The last month of daily candles for every stock, read once a day (they do not change while trading). */
  async loadDaily() {
    if (this.dailyDay === this.day || this.dailyLoading) return;
    this.dailyLoading = true;
    try {
      for (let i = 0; i < this.symbols.length; i += 5) {
        await Promise.all(
          this.symbols.slice(i, i + 5).map(async (symbol) => {
            try {
              const candles = await this.market.getDaily(symbol);
              if (candles.length) this.daily.set(symbol, candles);
            } catch (err) {
              logger.warn(`Scanner could not load ${symbol} daily candles: ${err.message}`);
            }
          }),
        );
      }
      this.dailyDay = this.day;
    } finally {
      this.dailyLoading = false;
    }
  }

  /** Switch off a setup whose last 20 finished ideas lost money on average; re-checked every 5 minutes. */
  async refreshSetupHealth() {
    if (Date.now() - this.setupCheckedAt < 5 * 60_000) return;
    this.setupCheckedAt = Date.now();
    const since = new Date(this.now().getTime() - SETUP_WINDOW_MS);
    const done = await ScanIdea.find({ status: { $ne: 'OPEN' }, closedAt: { $gte: since } }, 'setup side entry stopLoss exitPrice closedAt').sort({ closedAt: -1 }).limit(400).lean();
    const bySetup = new Map();
    for (const i of done) bySetup.set(i.setup, [...(bySetup.get(i.setup) || []), i]);
    const off = new Map();
    for (const [setup, list] of bySetup) {
      const rs = list.slice(0, SETUP_SAMPLE).map(resultR).filter((r) => r != null);
      if (rs.length < SETUP_SAMPLE) continue;
      const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
      if (avg < SETUP_MIN_AVG_R) off.set(setup, `${setup} is switched off: its last ${rs.length} ideas averaged ${avg.toFixed(2)}R`);
    }
    this.disabledSetups = off;
  }

  /** Nifty 50's own trend (VWAP and EMA 9/21 on 5-minute bars) and how many of the 50 stocks are up, read once a minute. */
  async refreshMarketState() {
    if (Date.now() - this.marketStateAt < MARKET_STATE_MS) return this.marketState;
    this.marketStateAt = Date.now();
    let niftyTrend = null;
    try {
      const c1 = await this.market.getCandles('NIFTY 50', '1m');
      const tick = this.market.getTick('NIFTY 50');
      const c5 = c1.length >= 40 ? aggregateCandles(c1, '5m') : [];
      if (c5.length >= 22 && tick) {
        const vwap = sessionVwap(c1);
        const e9 = ema(c5, 9).at(-1)?.value;
        const e21 = ema(c5, 21).at(-1)?.value;
        const up = tick.ltp > (vwap ?? tick.ltp) && e9 > e21;
        const down = tick.ltp < (vwap ?? tick.ltp) && e9 < e21;
        niftyTrend = up ? 1 : down ? -1 : 0;
      }
    } catch (err) {
      logger.warn(`Nifty 50 trend unavailable: ${err.message}`);
    }
    const moves = this.symbols.map((s) => this.market.getTick(s)?.changePct).filter((p) => p != null);
    const breadthUp = moves.length >= 20 ? moves.filter((p) => p > 0).length / moves.length : null;
    this.marketState = niftyTrend == null && breadthUp == null ? null : { niftyTrend, breadthUp };
    return this.marketState;
  }

  /** Why new ideas are paused, or null. Stops come in streaks on a choppy day, so rest after one. */
  chopReason() {
    const now = this.now();
    const last = this.finished.filter((f) => istParts(f.at).dateKey === this.day).slice(-CHOP_WINDOW);
    const stops = last.filter((f) => f.status === 'STOPPED');
    if (last.length < CHOP_WINDOW || stops.length < CHOP_STOPS) return null;
    const until = new Date(stops.at(-1).at.getTime() + CHOP_PAUSE_MS);
    return now < until ? `Choppy market: ${stops.length} of the last ${last.length} ideas were stopped out. New ideas are paused until ${until.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}` : null;
  }

  /** Load history for every stock in the background; the screen shows progress meanwhile. */
  warmUp() {
    this.warm ||= this.store.loadAll().then(() => {
      logger.info(`Scanner ready: ${this.store.loadedCount} stocks loaded`);
      return this.loadDaily();
    });
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

  /** symbol -> average % change of the other stocks in its sector, or null when it has no peers with a price. */
  #sectorMoves() {
    const bySector = new Map();
    for (const { symbol, sector } of NIFTY50) {
      const pct = this.market.getTick(symbol)?.changePct;
      if (pct == null) continue;
      bySector.set(sector, [...(bySector.get(sector) || []), { symbol, pct }]);
    }
    const sectorOf = new Map(NIFTY50.map((s) => [s.symbol, s.sector]));
    return (symbol) => {
      const peers = (bySector.get(sectorOf.get(symbol)) || []).filter((p) => p.symbol !== symbol);
      return peers.length ? peers.reduce((a, p) => a + p.pct, 0) / peers.length : null;
    };
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
    const res = await ScanIdea.updateOne({ _id: idea._id, status: 'OPEN' }, { status, exitPrice: price, closedAt, bestR: idea.bestR ?? 0, worstR: idea.worstR ?? 0 });
    if (!res.modifiedCount) return;
    if (status === 'STOPPED') this.#stockToday(idea.symbol).stopped = true;
    this.finished.push({ status, at: closedAt });
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
      const risk = Math.abs(idea.entry - idea.stopLoss);
      if (risk) {
        const r = ((long ? 1 : -1) * (ltp - idea.entry)) / risk;
        idea.bestR = Math.max(idea.bestR ?? 0, r);
        idea.worstR = Math.min(idea.worstR ?? 0, r);
      }
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
      const sectors = this.#sectorMoves();
      const marketState = await this.refreshMarketState();
      await this.refreshSetupHealth().catch((e) => logger.warn(`setup health check failed: ${e.message}`));
      if (this.dailyDay !== this.day && this.warm) this.loadDaily().catch((e) => logger.warn(`daily load failed: ${e.message}`));
      const entries = [];
      const watching = [];
      const rejected = [];
      const paused = this.chopReason();
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
        const { candidates } = evaluateStock({ symbol, tick, c1, niftyChangePct, sectorChangePct: sectors(symbol), daily: this.daily.get(symbol) ?? null, marketState, news: newsBySymbol[symbol] ?? null }, { now: this.now(), enforceWindows });
        const st = this.#stockToday(symbol);
        const strong = candidates.filter((c) => c.score >= MIN_SCORE);
        const openCount = [...this.open.values()].reduce((n, l) => n + l.length, 0);
        const stockBlock = paused ? paused : openCount >= MAX_OPEN_IDEAS ? `Already ${openCount} ideas open, so new ones wait` : st.stopped ? 'Already stopped out on this stock today' : st.count >= MAX_IDEAS_PER_STOCK ? `Already had ${st.count} ideas on this stock today` : null;
        const ok = stockBlock ? null : strong.find((c) => c.status !== 'MISSED' && !c.blocked.length && !this.disabledSetups.has(c.setup));
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
          const reasons = [...(stockBlock ? [stockBlock] : []), ...(this.disabledSetups.has(top.setup) ? [this.disabledSetups.get(top.setup)] : []), ...(top.status === 'MISSED' ? ['Price already ran past the entry zone. Do not chase it.'] : []), ...top.blocked];
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
        paused,
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
