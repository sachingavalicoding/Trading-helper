import { EventEmitter } from 'node:events';
import { Order, Position, Trade } from '../models/index.js';
import { isTradable } from '../market/instruments.js';
import { getMarketStatus } from '../market/marketHours.js';
import { calculateCharges, splitCharges } from './charges.js';
import { getFunds, adjustBalance, resetAccount } from './walletService.js';
import { KeyedMutex } from '../utils/keyedMutex.js';
import { round2, roundToTick } from '../utils/money.js';
import { badRequest, notFound, unavailable } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const EXIT_ROLES = ['STOPLOSS', 'TARGET'];
const MAX_LIMIT_DEVIATION = 0.2; // reject limit prices more than 20% away from LTP
const opposite = (side) => (side === 'BUY' ? 'SELL' : 'BUY');
const sign = (side) => (side === 'BUY' ? 1 : -1);

/** Should a resting order execute at this LTP? Exported for tests. */
export function isTriggered(order, ltp) {
  if (order.orderType === 'LIMIT') return order.side === 'BUY' ? ltp <= order.price : ltp >= order.price;
  if (order.orderType === 'SL_M') return order.side === 'BUY' ? ltp >= order.triggerPrice : ltp <= order.triggerPrice;
  return false;
}

/**
 * Paper order engine. Market orders fill at the live LTP; limit, stop-loss and target
 * orders rest in an in-memory book and are checked on every tick for their symbol.
 *
 * Emits 'update' ({ userId, kind: 'order'|'fill'|'squareoff', order, trades, message }).
 */
export class OrderEngine extends EventEmitter {
  constructor({ market, config, now = () => new Date() }) {
    super();
    this.market = market;
    this.config = config;
    this.now = now;
    this.locks = new KeyedMutex();
    this.book = new Map(); // symbol -> Map(orderId -> lean order)
    this.lastSquareOffDay = null;
    this.timer = null;
    this.onTick = this.onTick.bind(this);
  }

  async init() {
    const open = await Order.find({ status: 'OPEN' }).lean();
    for (const o of open) this.#addToBook(o);
    this.market.on('tick', this.onTick);
    logger.info(`Order engine ready, ${open.length} resting orders loaded`);
  }

  startScheduler(intervalMs = 5000) {
    this.timer = setInterval(() => this.checkSquareOff().catch((e) => logger.error('square-off failed', e)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.market.off('tick', this.onTick);
  }

  marketStatus() {
    return getMarketStatus(this.now(), this.config.nseHolidays);
  }

  // ---------- public API (each call is serialised per user) ----------

  placeOrder(userId, input) {
    return this.locks.run(String(userId), () => this.#place(userId, input));
  }

  cancelOrder(userId, orderId) {
    return this.locks.run(String(userId), async () => {
      const order = await Order.findOne({ _id: orderId, user: userId });
      if (!order) throw notFound('Order not found');
      if (order.status !== 'OPEN') throw badRequest(`Order is already ${order.status.toLowerCase()}`, 'NOT_OPEN');
      await this.#cancel(order, 'Cancelled by user');
      return order;
    });
  }

  /**
   * Move the price of a resting order (limit price, or the trigger of a stop-loss). Used by the
   * chart's draggable SL / target / limit lines.
   */
  modifyOrder(userId, orderId, newPrice) {
    return this.locks.run(String(userId), async () => {
      const order = await Order.findOne({ _id: orderId, user: userId });
      if (!order) throw notFound('Order not found');
      if (order.status !== 'OPEN') throw badRequest(`Order is already ${order.status.toLowerCase()}`, 'NOT_OPEN');

      const price = roundToTick(Number(newPrice));
      if (!(price > 0)) throw badRequest('Price must be greater than zero', 'INVALID_PRICE');
      const ltp = this.market.getLtp(order.symbol);
      if (!ltp) throw unavailable('No live price for this stock yet. Try again in a moment.', 'NO_PRICE');

      const isBuy = order.side === 'BUY';
      if (order.role === 'STOPLOSS') {
        // A buy-stop (covering a short) sits above the market, a sell-stop below it.
        if (isBuy ? price <= ltp : price >= ltp) {
          throw badRequest(`Stop-loss must be ${isBuy ? 'above' : 'below'} the current price`, 'INVALID_SL');
        }
        order.triggerPrice = price;
      } else if (order.role === 'TARGET') {
        if (isBuy ? price >= ltp : price <= ltp) {
          throw badRequest(`Target must be ${isBuy ? 'below' : 'above'} the current price`, 'INVALID_TARGET');
        }
        order.price = price;
      } else if (order.orderType === 'LIMIT') {
        if (Math.abs(price - ltp) / ltp > MAX_LIMIT_DEVIATION) {
          throw badRequest('Limit price is more than 20% away from the current price', 'INVALID_PRICE');
        }
        const position = await Position.findOne({ user: userId, symbol: order.symbol, status: 'OPEN' });
        const openingQty = this.#openingQty(position, order.side, order.qty);
        if (openingQty > 0) {
          const funds = await getFunds(userId, this.config.startingBalance);
          const required = this.#marginFor(openingQty, price) + calculateCharges({ side: order.side, qty: order.qty, price }).total;
          if (required > funds.available + order.blockedMargin) {
            throw badRequest(`Insufficient funds. Required ₹${round2(required)}, available ₹${round2(funds.available + order.blockedMargin)}.`, 'INSUFFICIENT_FUNDS');
          }
        }
        order.price = price;
        order.blockedMargin = round2(this.#marginFor(openingQty, price));
      } else {
        throw badRequest('This order cannot be modified', 'NOT_MODIFIABLE');
      }

      await order.save();
      this.#addToBook(order.toObject()); // replaces the cached trigger/price
      this.emit('update', { userId: String(userId), kind: 'order', order: order.toJSON() });
      return order;
    });
  }

  /** One-tap exit of an open position at market. */
  exitPosition(userId, symbol) {
    return this.locks.run(String(userId), async () => {
      const pos = await Position.findOne({ user: userId, symbol, status: 'OPEN' });
      if (!pos) throw notFound('No open position in this stock');
      return this.#marketExit(pos, 'EXIT');
    });
  }

  /** Exit every open position and cancel every resting order (auto square-off or "exit all"). */
  async squareOff({ userId = null, reason = 'Auto square-off at 15:15 IST' } = {}) {
    const filter = userId ? { user: userId } : {};
    const users = new Set([
      ...(await Order.distinct('user', { ...filter, status: 'OPEN' })).map(String),
      ...(await Position.distinct('user', { ...filter, status: 'OPEN' })).map(String),
    ]);
    let exited = 0;
    for (const uid of users) {
      await this.locks.run(uid, async () => {
        for (const order of await Order.find({ user: uid, status: 'OPEN' })) await this.#cancel(order, reason);
        for (const pos of await Position.find({ user: uid, status: 'OPEN' })) {
          try {
            await this.#marketExit(pos, 'SQUAREOFF');
            exited++;
          } catch (err) {
            logger.warn(`square-off ${pos.symbol} for ${uid} failed: ${err.message}`);
          }
        }
        this.emit('update', { userId: uid, kind: 'squareoff', message: reason });
      });
    }
    return { users: users.size, positionsExited: exited };
  }

  async checkSquareOff() {
    if (!this.config.enforceMarketHours) return; // mock practice mode: no clock-driven square-off
    const status = this.marketStatus();
    if (status.afterSquareOff && this.lastSquareOffDay !== status.istDate) {
      this.lastSquareOffDay = status.istDate;
      const res = await this.squareOff();
      logger.info(`Auto square-off done: ${res.positionsExited} positions across ${res.users} users`);
    }
  }

  resetAccount(userId) {
    return this.locks.run(String(userId), async () => {
      for (const symbolBook of this.book.values()) {
        for (const [id, o] of symbolBook) if (String(o.user) === String(userId)) symbolBook.delete(id);
      }
      await resetAccount(userId, this.config.startingBalance);
    });
  }

  onTick(tick) {
    const resting = this.book.get(tick.symbol);
    if (!resting?.size) return;
    if (this.config.enforceMarketHours && !this.marketStatus().isOpen) return;
    for (const lean of resting.values()) {
      if (lean.inFlight || !isTriggered(lean, tick.ltp)) continue;
      lean.inFlight = true;
      this.locks
        .run(String(lean.user), () => this.#fillResting(lean._id, tick.ltp))
        .catch((err) => logger.error(`fill ${lean._id} failed`, err))
        .finally(() => {
          lean.inFlight = false;
        });
    }
  }

  // ---------- internals (always called while holding the user's lock) ----------

  async #place(userId, input) {
    const symbol = String(input.symbol || '').toUpperCase();
    const side = input.side;
    const orderType = input.orderType;
    const qty = Number(input.qty);

    if (!isTradable(symbol)) throw badRequest('Only Nifty 50 stocks can be traded', 'INVALID_SYMBOL');
    if (!['BUY', 'SELL'].includes(side)) throw badRequest('side must be BUY or SELL');
    if (!['MARKET', 'LIMIT'].includes(orderType)) throw badRequest('orderType must be MARKET or LIMIT');
    if (!Number.isInteger(qty) || qty < 1) throw badRequest('Quantity must be a whole number of at least 1', 'INVALID_QTY');
    if (qty > this.config.maxOrderQty) throw badRequest(`Quantity cannot exceed ${this.config.maxOrderQty}`, 'INVALID_QTY');

    const ltp = this.market.getLtp(symbol);
    if (!ltp) throw unavailable('No live price for this stock yet. Try again in a moment.', 'NO_PRICE');

    const price = orderType === 'LIMIT' ? roundToTick(Number(input.price)) : undefined;
    if (orderType === 'LIMIT') {
      if (!(price > 0)) throw badRequest('Limit price is required', 'INVALID_PRICE');
      if (Math.abs(price - ltp) / ltp > MAX_LIMIT_DEVIATION) {
        throw badRequest('Limit price is more than 20% away from the current price', 'INVALID_PRICE');
      }
    }
    const ref = price ?? ltp;
    const stopLoss = input.stopLoss ? roundToTick(Number(input.stopLoss)) : undefined;
    const target = input.target ? roundToTick(Number(input.target)) : undefined;
    if (side === 'BUY') {
      if (stopLoss && stopLoss >= ref) throw badRequest('For a buy, stop-loss must be below the entry price', 'INVALID_SL');
      if (target && target <= ref) throw badRequest('For a buy, target must be above the entry price', 'INVALID_TARGET');
    } else {
      if (stopLoss && stopLoss <= ref) throw badRequest('For a sell, stop-loss must be above the entry price', 'INVALID_SL');
      if (target && target >= ref) throw badRequest('For a sell, target must be below the entry price', 'INVALID_TARGET');
    }

    const status = this.marketStatus();
    const order = new Order({
      user: userId,
      symbol,
      side,
      orderType,
      qty,
      price,
      stopLoss,
      target,
      role: 'ENTRY',
      ltpAtPlacement: ltp,
      tradingDay: status.istDate,
    });

    const position = await Position.findOne({ user: userId, symbol, status: 'OPEN' });
    const openingQty = this.#openingQty(position, side, qty);

    let reject = null;
    if (this.config.enforceMarketHours && !status.isOpen) reject = 'Market is closed. NSE trades 09:15 to 15:30 IST, Monday to Friday.';
    else if (this.config.enforceMarketHours && status.afterSquareOff && openingQty > 0) {
      reject = 'New intraday positions are not allowed after the 15:15 IST square-off.';
    } else if (openingQty > 0) {
      const required = this.#marginFor(openingQty, ref) + calculateCharges({ side, qty, price: ref }).total;
      const funds = await getFunds(userId, this.config.startingBalance);
      if (required > funds.available) {
        reject = `Insufficient funds. Required ₹${round2(required)}, available ₹${funds.available}.`;
      }
    }
    if (reject) {
      order.status = 'REJECTED';
      order.rejectReason = reject;
      await order.save();
      this.emit('update', { userId: String(userId), kind: 'order', order: order.toJSON(), message: reject });
      return { order, trades: [] };
    }

    const marketable = orderType === 'MARKET' || isTriggered(order, ltp);
    if (marketable) return this.#fill(order, ltp);

    order.blockedMargin = round2(this.#marginFor(openingQty, price));
    await order.save();
    this.#addToBook(order.toObject());
    this.emit('update', { userId: String(userId), kind: 'order', order: order.toJSON() });
    return { order, trades: [] };
  }

  async #fillResting(orderId, ltp) {
    const order = await Order.findById(orderId);
    if (!order || order.status !== 'OPEN') {
      this.#removeFromBook(order?.symbol, orderId);
      return null;
    }
    const price = this.market.getLtp(order.symbol) ?? ltp;
    if (!isTriggered(order, price)) return null; // price moved back before we got the lock

    if (order.role === 'ENTRY') {
      const position = await Position.findOne({ user: order.user, symbol: order.symbol, status: 'OPEN' });
      const openingQty = this.#openingQty(position, order.side, order.qty);
      if (openingQty > 0) {
        const funds = await getFunds(order.user, this.config.startingBalance);
        const required = this.#marginFor(openingQty, price) + calculateCharges({ side: order.side, qty: order.qty, price }).total;
        if (required > funds.available + order.blockedMargin) {
          order.status = 'REJECTED';
          order.rejectReason = 'Insufficient funds when the order triggered';
          order.blockedMargin = 0;
          await order.save();
          this.#removeFromBook(order.symbol, order._id);
          this.emit('update', { userId: String(order.user), kind: 'order', order: order.toJSON(), message: order.rejectReason });
          return null;
        }
      }
    }
    return this.#fill(order, price);
  }

  async #marketExit(pos, role) {
    const ltp = this.market.getLtp(pos.symbol);
    if (!ltp) throw unavailable(`No live price for ${pos.symbol}`, 'NO_PRICE');
    // Cancel resting SL/target legs first so they cannot fire after the exit.
    for (const leg of await Order.find({ user: pos.user, symbol: pos.symbol, status: 'OPEN', role: { $in: EXIT_ROLES } })) {
      await this.#cancel(leg, role === 'SQUAREOFF' ? 'Cancelled by square-off' : 'Cancelled on exit');
    }
    const order = new Order({
      user: pos.user,
      symbol: pos.symbol,
      side: pos.netQty > 0 ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      qty: Math.abs(pos.netQty),
      role,
      ltpAtPlacement: ltp,
      tradingDay: this.marketStatus().istDate,
    });
    return this.#fill(order, ltp);
  }

  /**
   * Execute `order` in full at `price`: update the position (closing first, then opening any
   * remainder), book charges and P&L to the wallet, write trade-book rows, and manage SL/target legs.
   */
  async #fill(order, price) {
    const userId = order.user;
    let position = await Position.findOne({ user: userId, symbol: order.symbol, status: 'OPEN' });

    if (EXIT_ROLES.includes(order.role)) {
      // Exit legs are reduce-only: never let them open or flip a position.
      if (!position || sign(order.side) === Math.sign(position.netQty)) {
        await this.#cancel(order, 'Position already closed');
        return { order, trades: [] };
      }
      order.qty = Math.min(order.qty, Math.abs(position.netQty));
    }

    const { side, qty, symbol } = order;
    const now = this.now();
    const tradingDay = this.marketStatus().istDate;
    const charges = calculateCharges({ side, qty, price });
    const trades = [];
    let remaining = qty;
    let pnlDelta = 0;
    let closedHere = false;

    if (position && sign(side) !== Math.sign(position.netQty)) {
      const closeQty = Math.min(remaining, Math.abs(position.netQty));
      const pnl = round2((position.netQty > 0 ? price - position.avgPrice : position.avgPrice - price) * closeQty);
      const ch = closeQty === qty ? charges : splitCharges(charges, closeQty / qty);
      const before = Math.abs(position.netQty);
      position.netQty += sign(side) * closeQty;
      this.#bookSide(position, side, closeQty, price);
      position.realizedPnl = round2(position.realizedPnl + pnl);
      position.charges = round2(position.charges + ch.total);
      position.margin = round2(position.margin * (Math.abs(position.netQty) / before));
      if (position.netQty === 0) {
        position.status = 'CLOSED';
        position.closedAt = now;
        position.margin = 0;
      }
      await position.save();
      trades.push(this.#trade(order, position, closeQty, price, ch, pnl, now, tradingDay));
      pnlDelta += pnl;
      remaining -= closeQty;
      if (position.status === 'CLOSED') {
        position = null;
        closedHere = true;
      }
    }

    if (remaining > 0) {
      const ch = remaining === qty ? charges : splitCharges(charges, remaining / qty);
      if (position) {
        const held = Math.abs(position.netQty);
        position.avgPrice = round2((position.avgPrice * held + price * remaining) / (held + remaining));
        position.netQty += sign(side) * remaining;
      } else {
        position = new Position({
          user: userId,
          symbol,
          direction: side === 'BUY' ? 'LONG' : 'SHORT',
          netQty: sign(side) * remaining,
          avgPrice: price,
          openedAt: now,
          tradingDay,
        });
      }
      this.#bookSide(position, side, remaining, price);
      position.charges = round2(position.charges + ch.total);
      position.margin = round2(position.margin + this.#marginFor(remaining, price));
      await position.save();
      trades.push(this.#trade(order, position, remaining, price, ch, 0, now, tradingDay));
    }

    await Trade.insertMany(trades);
    await adjustBalance(userId, pnlDelta - charges.total);

    order.status = 'FILLED';
    order.filledQty = qty;
    order.avgFillPrice = price;
    order.filledAt = now;
    order.blockedMargin = 0;
    await order.save();
    this.#removeFromBook(symbol, order._id);

    if (EXIT_ROLES.includes(order.role) && order.ocoGroup) {
      for (const sib of await Order.find({ ocoGroup: order.ocoGroup, status: 'OPEN', _id: { $ne: order._id } })) {
        await this.#cancel(sib, `${order.role === 'STOPLOSS' ? 'Stop-loss' : 'Target'} hit`);
      }
    }
    const stillOpen = await Position.findOne({ user: userId, symbol, status: 'OPEN' });
    // Also when an order flips the position: the old side's SL/target legs no longer apply.
    if (!stillOpen || closedHere) {
      for (const leg of await Order.find({ user: userId, symbol, status: 'OPEN', role: { $in: EXIT_ROLES } })) {
        await this.#cancel(leg, 'Position closed');
      }
    } else if (order.role === 'ENTRY' && (order.stopLoss || order.target) && remaining > 0) {
      await this.#createExitLegs(order, remaining, tradingDay);
    }

    const label = order.role === 'STOPLOSS' ? 'Stop-loss hit' : order.role === 'TARGET' ? 'Target hit' : 'Order filled';
    this.emit('update', {
      userId: String(userId),
      kind: 'fill',
      order: order.toJSON(),
      trades: trades.map((t) => t.toJSON()),
      message: `${label}: ${side} ${qty} ${symbol} @ ₹${price.toFixed(2)}`,
    });
    return { order, trades };
  }

  async #createExitLegs(entry, qty, tradingDay) {
    const exitSide = opposite(entry.side);
    const common = { user: entry.user, symbol: entry.symbol, side: exitSide, qty, parentOrder: entry._id, ocoGroup: String(entry._id), tradingDay };
    const legs = [];
    if (entry.stopLoss) legs.push(new Order({ ...common, orderType: 'SL_M', triggerPrice: entry.stopLoss, role: 'STOPLOSS' }));
    if (entry.target) legs.push(new Order({ ...common, orderType: 'LIMIT', price: entry.target, role: 'TARGET' }));
    for (const leg of legs) {
      await leg.save();
      this.#addToBook(leg.toObject());
    }
  }

  async #cancel(order, reason) {
    order.status = 'CANCELLED';
    order.cancelledAt = this.now();
    order.rejectReason = reason;
    order.blockedMargin = 0;
    await order.save();
    this.#removeFromBook(order.symbol, order._id);
    this.emit('update', { userId: String(order.user), kind: 'order', order: order.toJSON() });
  }

  #trade(order, position, qty, price, charges, pnl, now, tradingDay) {
    return new Trade({
      user: order.user,
      order: order._id,
      position: position._id,
      symbol: order.symbol,
      side: order.side,
      role: order.role,
      qty,
      price,
      value: round2(qty * price),
      charges,
      realizedPnl: pnl,
      executedAt: now,
      tradingDay,
    });
  }

  #bookSide(position, side, qty, price) {
    if (side === 'BUY') {
      position.buyQty += qty;
      position.buyValue = round2(position.buyValue + qty * price);
    } else {
      position.sellQty += qty;
      position.sellValue = round2(position.sellValue + qty * price);
    }
  }

  // Shares in this order that add exposure (the rest only reduces an existing position).
  #openingQty(position, side, qty) {
    if (!position || sign(side) === Math.sign(position.netQty)) return qty;
    return Math.max(0, qty - Math.abs(position.netQty));
  }

  #marginFor(qty, price) {
    return (qty * price) / this.config.misLeverage;
  }

  #addToBook(order) {
    if (!this.book.has(order.symbol)) this.book.set(order.symbol, new Map());
    this.book.get(order.symbol).set(String(order._id), {
      _id: order._id,
      user: order.user,
      side: order.side,
      orderType: order.orderType,
      price: order.price,
      triggerPrice: order.triggerPrice,
      inFlight: false,
    });
  }

  #removeFromBook(symbol, orderId) {
    if (symbol) this.book.get(symbol)?.delete(String(orderId));
  }
}
