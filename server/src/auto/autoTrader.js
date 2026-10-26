import { AutoSettings, Order, Position, Trade } from '../models/index.js';
import { getFunds } from '../services/walletService.js';
import { sizePosition } from '../scanner/sizing.js';
import { logger } from '../utils/logger.js';

const round2 = (n) => Math.round(n * 100) / 100;

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
    this.onEntry = (idea) => {
      this.handle(idea).catch((e) => logger.error('auto-trader failed', e));
    };
  }

  start() {
    this.scanner.on('entry', this.onEntry);
  }

  stop() {
    this.scanner.off('entry', this.onEntry);
  }

  /** Orders the auto-trader placed today (entries and their stop/target legs). */
  async #todaysAutoOrders(userId) {
    return Order.find({ user: userId, source: 'AUTO', tradingDay: this.engine.marketStatus().istDate }, '_id symbol role status').lean();
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

  /** Decide for one user. Returns a short reason when it skips, or the order when it places one. */
  async consider(settings, idea) {
    const userId = settings.user;
    const key = `${userId}|${idea._id}`;
    if (this.handled.has(key)) return { skipped: 'already handled' };
    this.handled.add(key);

    // The idea was raised a moment ago; skip it if price has already run away from the entry.
    const ltp = this.engine.market.getLtp(idea.symbol);
    const risk = Math.abs(idea.entry - idea.stopLoss);
    if (ltp && risk) {
      const movedR = ((idea.side === 'BUY' ? 1 : -1) * (ltp - idea.entry)) / risk;
      if (movedR > 0.5 || movedR < -0.3) return { skipped: `price already moved ${movedR.toFixed(2)}R from the entry` };
    }
    if (idea.score < settings.minScore) return { skipped: `score ${idea.score} is below ${settings.minScore}` };
    if (await Position.findOne({ user: userId, symbol: idea.symbol, status: 'OPEN' })) return { skipped: 'already in this stock' };

    const funds = await getFunds(userId, this.config.startingBalance);
    const today = await this.todaySummary(userId);
    if (today.open >= settings.maxOpen) return { skipped: `already ${today.open} auto trades open` };
    if (today.pnl <= -(funds.balance * settings.dailyLossPct) / 100) return { skipped: 'daily loss limit reached' };

    const size = sizePosition({
      capital: funds.balance,
      riskPct: settings.riskPct,
      entry: idea.entry,
      stopLoss: idea.stopLoss,
      available: funds.available,
      leverage: this.config.misLeverage,
      maxQty: this.config.maxOrderQty,
      maxAmount: settings.maxTradeAmount,
    });
    if (size.qty < 1) return { skipped: size.note || 'no size fits the risk limit' };

    const { order } = await this.engine.placeOrder(userId, {
      symbol: idea.symbol,
      side: idea.side,
      orderType: 'MARKET',
      qty: settings.maxShares > 0 ? Math.min(size.qty, settings.maxShares) : size.qty,
      stopLoss: idea.stopLoss,
      target: idea.target2, // target 1 is not a sell: it only lifts the stop, see setStep
      source: 'AUTO',
    });
    await this.engine.setStep(userId, idea.symbol, idea.target1);
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
