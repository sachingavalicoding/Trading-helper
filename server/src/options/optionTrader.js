import { AutoLog, OptionSettings, Order, Position, Trade } from '../models/index.js';
import { getFunds } from '../services/walletService.js';
import { UNDERLYING, isOptionSymbol, optionLabel } from './symbols.js';
import { readNifty } from './signal.js';
import { planTrade } from './plan.js';
import { istParts } from '../market/marketHours.js';
import { logger } from '../utils/logger.js';

const round2 = (n) => Math.round(n * 100) / 100;

const SCAN_MS = 15000;
const EXIT_MINUTE = 15 * 60; // all option trades are closed by 15:00 IST: the last half hour is where premiums melt and spreads widen
const STALL_MINUTES = 30; // a trade that has gone nowhere for this long is closed: time decay works against it every minute
const STALL_PROGRESS_R = 0.3; // "gone nowhere" = never got this far (in risk units) in our favour
const COOLDOWN_AFTER_STOP_MIN = 20;
const SAME_SIDE_COOLDOWN_MIN = 15;
const LOG_REPEAT_MS = 30 * 60000; // the same skip reason is written to the log at most this often

/**
 * Paper options trader for Nifty 50 index options. Every 15 seconds it reads the Nifty chart; when one side (call or put)
 * has a strong, unblocked case it buys one at-the-money contract with a stop taken from the chart, a target ladder and a
 * profit lock. It also closes trades the chart has proved wrong, trades that have stalled, and everything by 15:00.
 * It only ever calls the paper order engine.
 */
export class OptionTrader {
  constructor({ market, engine, config, scanner = null, now = () => new Date() }) {
    this.market = market;
    this.engine = engine;
    this.config = config;
    this.scanner = scanner;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.open = new Map(); // `${userId}|${symbol}` -> what the trade needs watching for
    this.exiting = new Set();
    this.reasons = new Map(); // `${userId}|${symbol}` -> why we exited at market (STOP, TIME)
    this.logged = new Map(); // dedupe key -> time of the last log row
    this.lastRead = null;
    this.onTick = (t) => this.#onTick(t);
    this.onUpdate = (u) => {
      if (u.kind === 'fill' && u.order && isOptionSymbol(u.order.symbol) && u.order.role !== 'ENTRY') this.#finish(u).catch((e) => logger.warn(`options log update failed: ${e.message}`));
    };
  }

  /** Pick up trades that were open when the server last stopped, so their chart stops keep working. */
  async init() {
    for (const log of await AutoLog.find({ segment: 'OPT', status: 'OPEN' }).lean()) {
      this.#watch(log.user, log.symbol, {
        type: log.detail?.type,
        stopSpot: log.detail?.stopSpot,
        entry: log.fillPrice ?? log.entry,
        risk: Math.abs((log.fillPrice ?? log.entry) - log.stopLoss),
        openedAt: log.decidedAt,
        bestR: log.detail?.bestR ?? 0,
        worstR: log.detail?.worstR ?? 0,
      });
      await this.market.watchOption(log.symbol, log.detail?.contract ?? null).catch(() => {});
    }
    // Any other open option position or resting order (placed by hand) also needs a live price to be managed.
    const symbols = new Set([...(await Position.distinct('symbol', { segment: 'OPT', status: 'OPEN' })), ...(await Order.distinct('symbol', { segment: 'OPT', status: 'OPEN' }))]);
    for (const symbol of symbols) await this.market.watchOption(symbol).catch(() => {});
  }

  start() {
    this.market.on('tick', this.onTick);
    this.engine.on('update', this.onUpdate);
    this.timer = setInterval(() => this.scan().catch((e) => logger.warn(`options scan failed: ${e.message}`)), SCAN_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.market.off('tick', this.onTick);
    this.engine.off('update', this.onUpdate);
  }

  #watch(userId, symbol, info) {
    this.open.set(`${userId}|${symbol}`, { user: String(userId), symbol, ...info });
  }

  /** The Nifty chart read, both sides, as of now. */
  async read() {
    const [c1, daily] = await Promise.all([this.market.getCandles(UNDERLYING, '1m'), this.market.getDaily(UNDERLYING).catch(() => [])]);
    const read = readNifty(
      { c1, daily, tick: this.market.getTick(UNDERLYING), breadthUp: this.scanner?.marketState?.breadthUp ?? null },
      { now: this.now(), enforceWindows: this.config.enforceMarketHours },
    );
    this.lastRead = { at: Date.now(), read };
    return read;
  }

  async scan() {
    if (this.running) return;
    this.running = true;
    try {
      const all = await OptionSettings.find({ enabled: true }).lean();
      if (!all.length && !this.open.size) return;
      for (const s of all) await this.manage(s.user).catch((e) => logger.warn(`options manage failed: ${e.message}`));
      if (!all.length) return;
      const status = this.engine.marketStatus();
      if (this.config.enforceMarketHours && !status.isOpen) return;
      const read = await this.read();
      for (const s of all) {
        try {
          const r = await this.consider(s, read);
          if (r.skipped) logger.info(`options skip for ${s.user}: ${r.skipped}`);
        } catch (e) {
          logger.warn(`options order failed: ${e.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ---------- numbers for the screens ----------

  /** Option trades today: entries, how many are open, and the money made or lost after charges. */
  async todaySummary(userId) {
    const day = this.engine.marketStatus().istDate;
    const [entries, open, trades] = await Promise.all([
      Order.countDocuments({ user: userId, segment: 'OPT', role: 'ENTRY', status: 'FILLED', tradingDay: day }),
      Position.find({ user: userId, segment: 'OPT', status: 'OPEN' }, 'margin').lean(),
      Trade.find({ user: userId, segment: 'OPT', tradingDay: day }, 'realizedPnl charges').lean(),
    ]);
    return {
      trades: entries,
      open: open.length,
      spent: round2(open.reduce((s, p) => s + p.margin, 0)),
      pnl: round2(trades.reduce((s, t) => s + (t.realizedPnl || 0) - (t.charges?.total || 0), 0)),
    };
  }

  // ---------- deciding ----------

  async #record(settings, extra) {
    try {
      return await AutoLog.create({ user: settings.user, day: this.engine.marketStatus().istDate, segment: 'OPT', ...extra });
    } catch (e) {
      logger.warn(`options log write failed: ${e.message}`);
      return null;
    }
  }

  /** Log a skip, but not the same one every 15 seconds. */
  async #skip(settings, side, reason, extra = {}) {
    const key = `${settings.user}|${side.type}|${reason.replace(/-?\d+(\.\d+)?/g, '#')}`;
    const prev = this.logged.get(key);
    if (prev && Date.now() - prev < LOG_REPEAT_MS) return { skipped: reason };
    this.logged.set(key, Date.now());
    await this.#record(settings, {
      symbol: `NIFTY ${side.type}`,
      side: 'BUY',
      setup: side.trigger?.kind,
      score: side.score,
      decision: 'SKIPPED',
      status: 'SKIPPED',
      reason,
      entry: undefined,
      card: { checks: side.checks, gates: side.gates },
      detail: { type: side.type, spot: this.lastRead?.read?.spot, ...extra },
    });
    return { skipped: reason };
  }

  /** Decide for one user, and write the decision to the log. */
  async consider(settings, read) {
    if (!read?.ready) return { skipped: 'the Nifty chart is not ready yet' };
    const side = read.best;
    if (!side) {
      const lead = read.lead;
      // Only a strong lead that something blocked is worth a log row; a quiet market is not a decision.
      if (lead.score >= settings.minScore) return this.#skip(settings, lead, `${lead.type} scores ${lead.score} but is blocked: ${lead.blocked[0] || 'the other side scores nearly the same'}`);
      return { skipped: 'no setup' };
    }
    if (side.score < settings.minScore) return side.score >= settings.minScore - 10 ? this.#skip(settings, side, `score ${side.score} is below ${settings.minScore}`) : { skipped: 'no setup' };
    return this.#enter(settings, read, side);
  }

  async #enter(settings, read, side, { manual = false, lots = null } = {}) {
    const userId = settings.user;
    const today = await this.todaySummary(userId);
    const stop = (reason) => (manual ? { skipped: reason } : this.#skip(settings, side, reason));
    if (today.open >= settings.maxOpen) return stop(`already ${today.open} option trade${today.open > 1 ? 's' : ''} open`);
    if (!manual) {
      if (today.trades >= settings.maxTrades) return stop(`already took ${today.trades} option trades today`);
      if (today.pnl <= -(settings.budget * settings.dailyLossPct) / 100) return stop('daily loss limit reached');
      const wait = await this.#coolingDown(userId, side.type);
      if (wait) return stop(wait);
    }
    if (await Position.findOne({ user: userId, segment: 'OPT', status: 'OPEN', symbol: new RegExp(`-${side.type}$`) })) return stop(`already holding a ${side.type}`);

    const contract = await this.market.pickOption({ type: side.type, now: this.now() });
    if (!contract?.ltp) return stop('no option contract with a live price');
    const funds = await getFunds(userId, this.config.startingBalance);
    const planned = planTrade({ read: side, market: read.market, contract, premium: contract.ltp, settings, available: funds.available, spentBudget: today.spent, now: this.now(), lots });
    if (planned.skipped) return stop(planned.skipped);
    const plan = planned.plan;

    let order;
    try {
      ({ order } = await this.engine.placeOrder(userId, { symbol: plan.symbol, side: 'BUY', orderType: 'MARKET', qty: plan.qty, stopLoss: plan.stopLoss, target: plan.target3, source: manual ? 'MANUAL' : 'AUTO' }));
    } catch (e) {
      return stop(`order not placed: ${e.message}`);
    }
    if (order.status !== 'FILLED') return stop(order.rejectReason || `order was ${String(order.status).toLowerCase()}`);
    await this.engine.setSteps(userId, plan.symbol, [plan.target1, plan.target2]);
    try {
      await this.engine.setExits(userId, plan.symbol, { ...(plan.lockTrigger ? { lockTrigger: plan.lockTrigger, lockAmount: plan.lockAmount, lockRatio: plan.lockRatio } : {}), ...(plan.trailPct ? { trailPct: plan.trailPct } : {}) });
    } catch (e) {
      logger.warn(`options lock for ${plan.symbol} not set: ${e.message}`);
    }

    const position = await Position.findOne({ user: userId, symbol: plan.symbol, status: 'OPEN' }, '_id').lean();
    const fill = order.avgFillPrice ?? plan.premium;
    this.#watch(userId, plan.symbol, { type: plan.type, stopSpot: plan.stopSpot, entry: fill, risk: Math.max(fill - plan.stopLoss, 0.05), openedAt: this.now(), bestR: 0, worstR: 0 });
    await this.#record(settings, {
      symbol: plan.symbol,
      side: 'BUY',
      setup: side.trigger?.kind,
      score: side.score,
      decision: 'PLACED',
      status: 'OPEN',
      entry: plan.premium,
      stopLoss: plan.stopLoss,
      target1: plan.target1,
      target2: plan.target2,
      riskReward: plan.riskReward,
      ltp: contract.ltp,
      qty: order.qty,
      fillPrice: fill,
      order: order._id,
      position: position?._id,
      card: { checks: side.checks, gates: side.gates },
      detail: { ...plan, label: optionLabel(plan.symbol), manual, trigger: side.trigger, contract: { symbol: plan.symbol, strike: plan.strike, type: plan.type, expiry: plan.expiry, lotSize: plan.lotSize }, snapshot: read.snapshot },
    });
    return { order, plan };
  }

  /** Buy now by hand, with the same chart stop, ladder and lock as the automatic trader. `type` is 'CE' or 'PE'. */
  async enterManually(userId, type, lots = 1) {
    const read = await this.read();
    if (!read.ready) return { skipped: 'the Nifty chart is not ready yet' };
    const side = type === 'CE' ? read.ce : read.pe;
    const settings = { ...((await OptionSettings.findOne({ user: userId }).lean()) ?? new OptionSettings({ user: userId }).toObject()), user: userId };
    return this.#enter(settings, read, side, { manual: true, lots });
  }

  async #coolingDown(userId, type) {
    const last = await Position.find({ user: userId, segment: 'OPT', status: 'CLOSED', tradingDay: this.engine.marketStatus().istDate }).sort({ closedAt: -1 }).limit(1).lean();
    const p = last[0];
    if (!p?.closedAt) return null;
    const mins = (this.now() - p.closedAt) / 60000;
    const lost = p.realizedPnl - p.charges < 0;
    if (lost && mins < COOLDOWN_AFTER_STOP_MIN) return `cooling off for ${Math.ceil(COOLDOWN_AFTER_STOP_MIN - mins)} more minutes after a losing trade`;
    if (p.symbol.endsWith(`-${type}`) && mins < SAME_SIDE_COOLDOWN_MIN) return `a ${type} was closed ${Math.round(mins)} minutes ago`;
    return null;
  }

  // ---------- watching open trades ----------

  async #exit(userId, symbol, reason) {
    const key = `${userId}|${symbol}`;
    if (this.exiting.has(key)) return;
    this.exiting.add(key);
    this.reasons.set(key, reason);
    try {
      await this.engine.exitPosition(userId, symbol);
    } catch (e) {
      this.reasons.delete(key);
      logger.warn(`options exit of ${symbol} failed: ${e.message}`);
    } finally {
      this.exiting.delete(key);
    }
  }

  #onTick({ symbol, ltp }) {
    if (!this.open.size) return;
    for (const w of this.open.values()) {
      if (symbol === w.symbol && w.risk) {
        const r = (ltp - w.entry) / w.risk;
        w.bestR = Math.max(w.bestR, r);
        w.worstR = Math.min(w.worstR, r);
      }
      // The chart said the idea is wrong when the index crosses the stop level, even if the premium has not fallen that far yet.
      if (symbol === UNDERLYING && w.stopSpot != null && (w.type === 'CE' ? ltp <= w.stopSpot : ltp >= w.stopSpot)) {
        this.#exit(w.user, w.symbol, 'STOP').catch(() => {});
      }
    }
  }

  /** Time exits for one user's open option trades: the 15:00 cut-off, and trades that have stalled. */
  async manage(userId) {
    const { minutes } = istParts(this.now());
    for (const w of [...this.open.values()].filter((x) => x.user === String(userId))) {
      const held = (this.now() - new Date(w.openedAt)) / 60000;
      if (minutes >= EXIT_MINUTE) await this.#exit(w.user, w.symbol, 'TIME');
      else if (held >= STALL_MINUTES && w.bestR < STALL_PROGRESS_R && (this.market.getLtp(w.symbol) ?? w.entry) <= w.entry) await this.#exit(w.user, w.symbol, 'TIME');
    }
  }

  /** A stop, target, exit or square-off filled: if that closed an option trade, record how it ended. */
  async #finish({ userId, order }) {
    const log = await AutoLog.findOne({ user: userId, segment: 'OPT', symbol: order.symbol, status: 'OPEN' });
    if (!log) return;
    const pos = await Position.findById(log.position).lean();
    if (!pos || pos.status !== 'CLOSED') return;
    const key = `${userId}|${order.symbol}`;
    const w = this.open.get(key);
    this.open.delete(key);
    const why = this.reasons.get(key);
    this.reasons.delete(key);
    const gross = pos.realizedPnl;
    const exitReason = order.role === 'TARGET' ? 'TARGET' : order.role === 'STOPLOSS' ? (gross > 0 ? 'LOCK' : 'STOP') : order.role === 'SQUAREOFF' ? 'SQUARE_OFF' : why || 'MANUAL';
    const risk = Math.abs((log.fillPrice ?? log.entry) - log.stopLoss);
    const exitPrice = order.avgFillPrice;
    const outcome = {
      exitReason,
      exitPrice,
      grossPnl: round2(gross),
      charges: round2(pos.charges),
      netPnl: round2(gross - pos.charges),
      resultR: risk ? round2((exitPrice - (log.fillPrice ?? log.entry)) / risk) : null,
      minutesHeld: Math.round(((pos.closedAt || new Date()) - pos.openedAt) / 60000),
      bestR: w ? round2(w.bestR) : null,
      worstR: w ? round2(w.worstR) : null,
      closedAt: pos.closedAt,
    };
    await AutoLog.updateOne({ _id: log._id, status: 'OPEN' }, { status: 'CLOSED', outcome });
  }
}
