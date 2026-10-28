import { AutoLog, AutoSettings, Order, Position, Trade } from '../models/index.js';
import { getFunds } from '../services/walletService.js';
import { roundTripCharges } from '../services/charges.js';
import { sizePosition } from '../scanner/sizing.js';
import { loadRules } from '../models/TradeDefaults.js';
import { istParts } from '../market/marketHours.js';
import { normalizeCombos } from '../combos/combos.js';
import { bars5Of, breadthByTime, shareChart, shareIdeas, newsDirection } from '../combos/shares.js';
import { logger } from '../utils/logger.js';

const round2 = (n) => Math.round(n * 100) / 100;

const MIN_PROFIT_TO_CHARGES = 3; // skip a trade whose profit at target 1 is under this many times its round-trip charges
// There is no sale target. The order engine puts the user's profit lock (Account tab) on every new position: once the profit reaches
// the lock start the stop follows a fixed gap behind the best profit. A trade ends at its stop or at the 15:15 square-off.
const MIN_STOP_PCT = 0.5; // skip an idea whose stop is closer than this % of the entry: on 27-28 Oct the 4 trades with stops under 0.5% away lost 3 times within minutes
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
    this.timer = null;
    this.timed = new Set(); // `${userId}|${symbol}` of trades closed by the exit time, so the log says TIME
    this.comboSlot = 0; // the 5-minute slot the combinations were last read for
    this.comboBusy = false;
    this.onEntry = (idea) => {
      this.handle(idea).catch((e) => logger.error('auto-trader failed', e));
    };
  }

  start() {
    this.scanner.on('entry', this.onEntry);
    this.engine.market.on('tick', this.onTick);
    this.engine.on('update', this.onUpdate);
    this.timer = setInterval(() => this.closeOnTime().catch((e) => logger.warn(`auto time exit failed: ${e.message}`)), 30_000);
    this.timer.unref?.();
    this.comboTimer = setInterval(() => this.scanCombos().catch((e) => logger.warn(`combination scan failed: ${e.message}`)), 20_000);
    this.comboTimer.unref?.();
  }

  stop() {
    this.scanner.off('entry', this.onEntry);
    this.engine.market.off('tick', this.onTick);
    this.engine.off('update', this.onUpdate);
    clearInterval(this.timer);
    clearInterval(this.comboTimer);
  }

  /** Close the auto trader's open share trades once the clock reaches the exit time set in the Account tab (15:15 unless changed). */
  async closeOnTime() {
    if (!this.config.enforceMarketHours) return;
    const { minutes } = istParts(new Date());
    const open = await AutoLog.find({ segment: { $ne: 'OPT' }, status: 'OPEN', decision: 'PLACED' }, 'user symbol').lean();
    const exitMin = new Map();
    for (const row of open) {
      const uid = String(row.user);
      if (!exitMin.has(uid)) exitMin.set(uid, (await loadRules(uid, 'EQ')).exitMin);
      if (minutes < exitMin.get(uid)) continue;
      try {
        this.timed.add(`${uid}|${row.symbol}`);
        await this.engine.exitPosition(uid, row.symbol);
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Once per 5-minute bar, read every share's chart for the combinations the users built (Account > Entries) and hand the ones that
   * just became true to the same decision as a scanner idea. Each share is read on its own bars, with the 50-stock breadth and, for the
   * newest bar, its news. The scanner's own rules and the idea limits below apply as usual; the score check does not (a combination has no score).
   */
  async scanCombos() {
    const store = this.scanner?.store;
    if (!store || this.comboBusy) return { skipped: 'not ready' };
    const now = Date.now();
    const slot = Math.floor(now / 300_000);
    if (slot === this.comboSlot || now % 300_000 < 8000) return { skipped: 'wait for the bar to close' };
    if (this.config.enforceMarketHours && !this.engine.marketStatus().isOpen) return { skipped: 'market closed' };
    const users = (await AutoSettings.find({ enabled: true }).lean()).map((s) => ({ ...s, combos: normalizeCombos(s.combos).filter((c) => c.on) })).filter((s) => s.combos.length);
    this.comboSlot = slot;
    if (!users.length) return { skipped: 'no combination is switched on' };
    this.comboBusy = true;
    try {
      const stocks5 = {};
      for (const symbol of store.symbols) {
        const c1 = store.get(symbol);
        if (c1?.length > 100) stocks5[symbol] = bars5Of(c1, now / 1000);
      }
      const timeline = Object.values(stocks5).sort((a, b) => b.length - a.length)[0];
      if (!timeline) return { skipped: 'no candles yet' };
      const breadth = breadthByTime(timeline, stocks5);
      const news = (await this.scanner.news?.signals().catch(() => ({}))) ?? {};
      const exits = new Map();
      let made = 0;
      for (const [symbol, bars] of Object.entries(stocks5)) {
        const last = bars.at(-1);
        if (!last || now / 1000 - (last.time + 300) > 240) continue; // the newest closed bar is not recent: the feed is behind
        const dir = newsDirection(news[symbol]);
        const chart = shareChart(bars, { breadth, news: (i) => (i === bars.length - 1 ? dir : 0), from: Math.max(15, bars.length - 8) });
        for (const s of users) {
          const uid = String(s.user);
          if (!exits.has(uid)) exits.set(uid, (await loadRules(uid, 'EQ')).exitMin);
          for (const combo of s.combos) {
            for (const idea of shareIdeas(chart, combo, { symbol, from: bars.length - 1, exitMin: this.config.enforceMarketHours ? exits.get(uid) : 24 * 60 })) {
              if (idea.i !== bars.length - 1) continue;
              made += 1;
              const r = await this.consider(s, { ...idea, _id: `combo:${symbol}:${combo.id}:${last.time}`, riskReward: 1.5 });
              if (r.skipped) logger.info(`auto skip ${symbol} ${idea.side} (${combo.name}) for ${s.user}: ${r.skipped}`);
            }
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { made };
    } finally {
      this.comboBusy = false;
    }
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
    const exitReason = order.role === 'TARGET' ? 'TARGET' : order.role === 'STOPLOSS' ? (gross > 0 ? 'LOCK' : 'STOP') : order.role === 'SQUAREOFF' ? 'SQUARE_OFF' : this.timed.has(`${userId}|${order.symbol}`) ? 'TIME' : 'MANUAL';
    this.timed.delete(`${userId}|${order.symbol}`);
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
    if (risk && idea.entry && (risk / idea.entry) * 100 < MIN_STOP_PCT) return { skipped: `the stop is only ${round2((risk / idea.entry) * 100)}% from the entry, under the ${MIN_STOP_PCT}% minimum, so normal wiggle would hit it` };
    if (this.config.enforceMarketHours && istParts(new Date()).minutes >= (await loadRules(userId, 'EQ')).exitMin) return { skipped: 'past the exit time set in the Account tab' };
    if (!idea.combo && settings.skipSetups?.includes(idea.setup)) return { skipped: `${idea.setup} is switched off in the Account tab` };
    if (idea.setup === 'News gap' && settings.earlyNews === false) return { skipped: 'news gap trades are switched off' };
    if (!idea.combo && idea.score < settings.minScore) return { skipped: `score ${idea.score} is below ${settings.minScore}` };
    if (await Position.findOne({ user: userId, symbol: idea.symbol, status: 'OPEN' })) return { skipped: 'already in this stock' };

    const funds = await getFunds(userId, this.config.startingBalance);
    const today = await this.todaySummary(userId);
    if (today.open >= settings.maxOpen) return { skipped: `already ${today.open} auto trades open` };
    if (today.pnl <= -(funds.balance * settings.dailyLossPct) / 100) return { skipped: 'daily loss limit reached' };

    const size = sizePosition({
      capital: funds.balance,
      riskPct: settings.riskPct,
      riskAmount: (await loadRules(userId, 'EQ')).stopLoss, // the most one trade may lose is the stop set in the Account tab
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
    return { order };
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
