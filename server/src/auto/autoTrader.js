import { AutoLog, AutoSettings, Order, Position, Trade } from '../models/index.js';
import { getFunds } from '../services/walletService.js';
import { roundTripCharges } from '../services/charges.js';
import { sizePosition } from '../scanner/sizing.js';
import { LADDER } from '../scanner/replay.js';
import { effectiveLadder } from '../utils/ladder.js';
import { logger } from '../utils/logger.js';

const round2 = (n) => Math.round(n * 100) / 100;

const MIN_PROFIT_TO_CHARGES = 3; // skip a trade whose profit at target 1 is under this many times its round-trip charges
// There is no sale target. The stop climbs with the profit along the ladder in scanner/replay.js, as [profit, kept] in percent
// of the money put in: on ₹1 lakh, +₹300 keeps ₹150, +₹450 keeps ₹320, +₹600 keeps ₹520, +₹1,000 keeps ₹900, and past each rung
// the stop follows (profit - kept) behind the best profit. A trade ends at its stop or at the 15:15 square-off.
const DEFAULT_RISK_AMOUNT = 200; // rupees one trade may lose when the user's settings do not say
const MAX_CHARGES_OF_RISK = 0.25; // skip a trade whose round-trip charges are more than this share of the money it risks: its stop is too tight for its size

/**
 * Paper auto-trader. When the scanner raises an idea, it places a VIRTUAL order for every user
 * who switched it on, with the idea's stop loss and first target. It never talks to a broker:
 * it only calls the paper order engine. Each rule below can say no, and no is the default.
 */
export class AutoTrader {
  constructor({ scanner, engine, config }) {
    this.scanner = scanner;
    this.engine = engine;
    this.config = config;
    this.handled = new Set(); // `${userId}|${ideaId}`
    this.excursion = new Map(); // `${userId}|${symbol}` -> how far an open auto trade has run, in risk units
    this.onTick = (t) => this.#track(t);
    this.onUpdate = (u) => {
      if (u.kind === 'fill' && u.order && u.order.role !== 'ENTRY') this.#finish(u).catch((e) => logger.warn(`auto log update failed: ${e.message}`));
    };
    this.onEntry = (idea) => {
      this.handle(idea).catch((e) => logger.error('auto-trader failed', e));
    };
  }

  start() {
    this.scanner.on('entry', this.onEntry);
    this.engine.market.on('tick', this.onTick);
    this.engine.on('update', this.onUpdate);
  }

  stop() {
    this.scanner.off('entry', this.onEntry);
    this.engine.market.off('tick', this.onTick);
    this.engine.off('update', this.onUpdate);
  }

  #track({ symbol, ltp }) {
    for (const [key, x] of this.excursion) {
      if (x.symbol !== symbol || !x.risk) continue;
      const r = (x.dir * (ltp - x.entry)) / x.risk;
      x.bestR = Math.max(x.bestR, r);
      x.worstR = Math.min(x.worstR, r);
      this.excursion.set(key, x);
    }
  }

  /** Write one row of the auto log. Logging must never get in the way of trading. */
  async #record(settings, idea, extra) {
    try {
      return await AutoLog.create({
        user: settings.user,
        day: this.engine.marketStatus().istDate,
        idea: idea._id && /^[0-9a-f]{24}$/i.test(String(idea._id)) ? idea._id : undefined,
        symbol: idea.symbol,
        side: idea.side,
        setup: idea.setup,
        score: idea.score,
        entry: idea.entry,
        stopLoss: idea.stopLoss,
        target1: idea.target1,
        target2: idea.target2,
        riskReward: idea.riskReward,
        card: idea.card,
        ...extra,
      });
    } catch (e) {
      logger.warn(`auto log write failed: ${e.message}`);
      return null;
    }
  }

  /** A stop, target, manual exit or square-off filled: if that closed an auto trade, record how it ended. */
  async #finish({ userId, order }) {
    const log = await AutoLog.findOne({ user: userId, symbol: order.symbol, status: 'OPEN', segment: { $ne: 'OPT' } });
    if (!log) return;
    const pos = await Position.findById(log.position).lean();
    if (!pos || pos.status !== 'CLOSED') return;
    const key = `${userId}|${order.symbol}`;
    const x = this.excursion.get(key);
    this.excursion.delete(key);
    const gross = pos.realizedPnl;
    const exitReason = order.role === 'TARGET' ? 'TARGET' : order.role === 'STOPLOSS' ? (gross > 0 ? 'LOCK' : 'STOP') : order.role === 'SQUAREOFF' ? 'SQUARE_OFF' : 'MANUAL';
    const risk = Math.abs(log.entry - log.stopLoss);
    const dir = log.side === 'BUY' ? 1 : -1;
    const exitPrice = order.avgFillPrice;
    const outcome = {
      exitReason,
      exitPrice,
      grossPnl: round2(gross),
      charges: round2(pos.charges),
      netPnl: round2(gross - pos.charges),
      resultR: risk ? round2((dir * (exitPrice - (log.fillPrice ?? log.entry))) / risk) : null,
      minutesHeld: Math.round(((pos.closedAt || new Date()) - pos.openedAt) / 60000),
      bestR: x ? round2(x.bestR) : null,
      worstR: x ? round2(x.worstR) : null,
      closedAt: pos.closedAt,
    };
    await AutoLog.updateOne({ _id: log._id, status: 'OPEN' }, { status: 'CLOSED', outcome });
  }

  /** Orders the auto-trader placed today (entries and their stop/target legs). */
  async #todaysAutoOrders(userId) {
    return Order.find({ user: userId, source: 'AUTO', segment: { $ne: 'OPT' }, tradingDay: this.engine.marketStatus().istDate }, '_id symbol role status').lean();
  }

  /** Auto-trade P&L booked today, after charges. */
  async todaySummary(userId) {
    const orders = await this.#todaysAutoOrders(userId);
    const trades = orders.length ? await Trade.find({ user: userId, order: { $in: orders.map((o) => o._id) } }, 'realizedPnl charges').lean() : [];
    const pnl = round2(trades.reduce((s, t) => s + (t.realizedPnl || 0) - (t.charges?.total || 0), 0));
    const entries = orders.filter((o) => o.role === 'ENTRY' && o.status === 'FILLED');
    const symbols = [...new Set(entries.map((o) => o.symbol))];
    const open = symbols.length ? await Position.countDocuments({ user: userId, status: 'OPEN', symbol: { $in: symbols } }) : 0;
    return { trades: entries.length, open, pnl };
  }

  /** Decide for one user, and write the decision to the auto log. Returns a short reason when it skips, or the order when it places one. */
  async consider(settings, idea) {
    const key = `${settings.user}|${idea._id}`;
    if (this.handled.has(key)) return { skipped: 'already handled' };
    this.handled.add(key);

    const seen = {};
    const result = await this.#decide(settings, idea, seen);
    const base = { ltp: seen.ltp, movedR: seen.movedR };
    if (result.skipped) {
      await this.#record(settings, idea, { ...base, decision: 'SKIPPED', status: 'SKIPPED', reason: result.skipped });
    } else {
      const { order } = result;
      const position = await Position.findOne({ user: settings.user, symbol: idea.symbol, status: 'OPEN' }, '_id').lean();
      const risk = Math.abs(idea.entry - idea.stopLoss);
      this.excursion.set(`${settings.user}|${idea.symbol}`, { user: settings.user, openedAt: Date.now(), symbol: idea.symbol, entry: order.avgFillPrice ?? idea.entry, risk, dir: idea.side === 'BUY' ? 1 : -1, bestR: 0, worstR: 0 });
      await this.#record(settings, idea, { ...base, decision: 'PLACED', status: 'OPEN', qty: order.qty, fillPrice: order.avgFillPrice, order: order._id, position: position?._id });
    }
    return result;
  }

  async #decide(settings, idea, seen) {
    const userId = settings.user;

    // The idea was raised a moment ago; skip it if price has already run away from the entry.
    const ltp = this.engine.market.getLtp(idea.symbol);
    const risk = Math.abs(idea.entry - idea.stopLoss);
    seen.ltp = ltp || undefined;
    if (ltp && risk) {
      const movedR = ((idea.side === 'BUY' ? 1 : -1) * (ltp - idea.entry)) / risk;
      seen.movedR = round2(movedR);
      if (movedR > 0.5 || movedR < -0.3) return { skipped: `price already moved ${movedR.toFixed(2)}R from the entry` };
    }
    if (idea.setup === 'News gap' && settings.earlyNews === false) return { skipped: 'news gap trades are switched off' };
    if (idea.score < settings.minScore) return { skipped: `score ${idea.score} is below ${settings.minScore}` };
    if (await Position.findOne({ user: userId, symbol: idea.symbol, status: 'OPEN' })) return { skipped: 'already in this stock' };

    const funds = await getFunds(userId, this.config.startingBalance);
    const today = await this.todaySummary(userId);
    if (today.open >= settings.maxOpen) return { skipped: `already ${today.open} auto trades open` };
    if (today.pnl <= -(funds.balance * settings.dailyLossPct) / 100) return { skipped: 'daily loss limit reached' };

    const size = sizePosition({
      capital: funds.balance,
      riskPct: settings.riskPct,
      riskAmount: settings.riskAmount ?? DEFAULT_RISK_AMOUNT,
      entry: idea.entry,
      stopLoss: idea.stopLoss,
      available: funds.available,
      leverage: this.config.misLeverage,
      maxQty: this.config.maxOrderQty,
      maxAmount: settings.maxTradeAmount,
    });
    if (size.qty < 1) return { skipped: size.note || 'no size fits the risk limit' };

    const qty = settings.maxShares > 0 ? Math.min(size.qty, settings.maxShares) : size.qty;
    const profitAtT1 = qty * Math.abs(idea.target1 - idea.entry);
    const charges = roundTripCharges({ qty, price: idea.entry });
    const atRisk = qty * risk;
    if (atRisk > 0 && charges > MAX_CHARGES_OF_RISK * atRisk) {
      return { skipped: `charges (₹${charges}) are ${Math.round((charges / atRisk) * 100)}% of the ₹${round2(atRisk)} at risk, over the ${Math.round(MAX_CHARGES_OF_RISK * 100)}% limit; the stop is too tight for the size` };
    }
    if (profitAtT1 < MIN_PROFIT_TO_CHARGES * charges) {
      return { skipped: `profit at target 1 (₹${round2(profitAtT1)}) is under ${MIN_PROFIT_TO_CHARGES}x the charges (₹${charges})` };
    }

    const { order } = await this.engine.placeOrder(userId, {
      symbol: idea.symbol,
      side: idea.side,
      orderType: 'MARKET',
      qty,
      stopLoss: idea.stopLoss,
      source: 'AUTO',
    });
    // A rejected order (market closed, not enough funds) opened nothing, so it must not be logged as a placed trade.
    if (order.status !== 'FILLED') return { skipped: order.rejectReason || `order was ${String(order.status).toLowerCase()}` };
    if (settings.lockByRisk !== false) await this.#climbingStop(userId, order, idea, settings);
    return { order };
  }

  /** Set the climbing stop from the money put in, so it works at any balance and share price. */
  async #climbingStop(userId, order, idea, settings) {
    const value = (order.avgFillPrice ?? idea.entry) * order.qty;
    const lockSteps = effectiveLadder(settings.lockLadder, LADDER).map(([at, keep]) => ({ at: round2((value * at) / 100), keep: round2((value * keep) / 100) }));
    if (!lockSteps.every((s) => s.keep > 0 && s.at > s.keep)) return;
    try {
      await this.engine.setExits(userId, idea.symbol, { lockSteps });
    } catch (e) {
      logger.warn(`auto climbing stop for ${idea.symbol} not set: ${e.message}`);
    }
  }

  async handle(idea) {
    const all = await AutoSettings.find({ enabled: true }).lean();
    for (const s of all) {
      try {
        const r = await this.consider(s, idea);
        if (r.skipped) logger.info(`auto skip ${idea.symbol} ${idea.side} for ${s.user}: ${r.skipped}`);
      } catch (e) {
        logger.warn(`auto order for ${idea.symbol} failed: ${e.message}`);
      }
    }
  }
}
