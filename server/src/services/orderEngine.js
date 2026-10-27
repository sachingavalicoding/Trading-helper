import { EventEmitter } from 'node:events';
import { Order, Position, Trade, TradeDefaults } from '../models/index.js';
import { TRADE_DEFAULTS } from '../models/TradeDefaults.js';
import { isTradable } from '../market/instruments.js';
import { isOptionSymbol, DEFAULT_LOT_SIZE } from '../options/symbols.js';
import { getMarketStatus } from '../market/marketHours.js';
import { calculateCharges, roundTripCharges, splitCharges } from './charges.js';
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
const LOCK_CHARGES_MULT = 1.5; // a profit lock or target step never puts the stop below cost + this many times the round-trip charges
const STEP_KEEP = 0.8; // past a target, keep the stop this share of the way from entry to it (leaves room for a pullback)

export class OrderEngine extends EventEmitter {
  constructor({ market, config, now = () => new Date() }) {
    super();
    this.market = market;
    this.config = config;
    this.now = now;
    this.locks = new KeyedMutex();
    this.book = new Map(); // symbol -> Map(orderId -> lean order)
    this.trailing = new Map(); // symbol -> Map(positionId -> { user, trailPct, busy })
    this.lastSquareOffDay = null;
    this.timer = null;
    this.onTick = this.onTick.bind(this);
  }

  async init() {
    const open = await Order.find({ status: 'OPEN' }).lean();
    for (const o of open) this.#addToBook(o);
    for (const p of await Position.find({ status: 'OPEN', $or: [{ trailPct: { $ne: null } }, { lockTrigger: { $ne: null } }, { 'lockSteps.0': { $exists: true } }, { 'stepPrices.0': { $exists: true } }] }).lean()) this.#watchTrail(p);
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
   * Change the stop loss and target of an open position, or set a trailing stop.
   * Each field: a number sets it, null removes it, undefined leaves it alone.
   * `trailPct` makes the stop follow the price at that % distance and only ever move towards profit.
   */
  /** Arm the target ladder for an open position: past each price the stop jumps to STEP_KEEP of the way to it. */
  setSteps(userId, symbol, prices) {
    return this.locks.run(String(userId), async () => {
      const pos = await Position.findOneAndUpdate({ user: userId, symbol, status: 'OPEN' }, { stepPrices: prices }, { new: true });
      if (pos) this.#watchTrail(pos);
    });
  }

  setExits(userId, symbol, input = {}) {
    return this.locks.run(String(userId), () => this.#setExits(userId, symbol, input));
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
  async squareOff({ userId = null, reason = 'Auto square-off at 15:15 IST', segment = 'ALL' } = {}) {
    const bySegment = segment === 'OPT' ? { segment: 'OPT' } : segment === 'EQ' ? { segment: { $ne: 'OPT' } } : {};
    const filter = { ...(userId ? { user: userId } : {}), ...bySegment };
    const users = new Set([
      ...(await Order.distinct('user', { ...filter, status: 'OPEN' })).map(String),
      ...(await Position.distinct('user', { ...filter, status: 'OPEN' })).map(String),
    ]);
    let exited = 0;
    for (const uid of users) {
      await this.locks.run(uid, async () => {
        for (const order of await Order.find({ user: uid, status: 'OPEN', ...bySegment })) await this.#cancel(order, reason);
        for (const pos of await Position.find({ user: uid, status: 'OPEN', ...bySegment })) {
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
    this.#trail(tick);
    const resting = this.book.get(tick.symbol);
    if (!resting?.size) return;
    if (this.config.enforceMarketHours && !this.marketStatus().isOpen) return;
    for (const lean of resting.values()) {
      if (lean.inFlight || !isTriggered(lean, tick.ltp)) continue;
      lean.inFlight = true;
      this.locks
        .run(String(lean.user), () => this.#fillResting(lean._id, tick.ltp, tick.symbol))
        .catch((err) => logger.error(`fill ${lean._id} failed`, err))
        .finally(() => {
          lean.inFlight = false;
        });
    }
  }

  // ---------- internals (always called while holding the user's lock) ----------

  async #setExits(userId, symbol, { stopLoss, target, trailPct, lockTrigger, lockAmount, lockRatio, lockSteps }) {
    const pos = await Position.findOne({ user: userId, symbol, status: 'OPEN' });
    if (!pos) throw notFound('No open position in this stock');
    const ltp = this.market.getLtp(symbol);
    if (!ltp) throw unavailable('No live price for this stock yet. Try again in a moment.', 'NO_PRICE');
    const long = pos.netQty > 0;
    const tick = (v) => roundToTick(Number(v));
    const [minTrail, maxTrail] = pos.segment === 'OPT' ? [1, 60] : [0.1, 10]; // a premium swings far more than a share price
    if (trailPct != null && !(trailPct >= minTrail && trailPct <= maxTrail)) throw badRequest(`Trailing distance must be between ${minTrail}% and ${maxTrail}%`, 'INVALID_TRAIL');
    if (lockTrigger !== undefined || lockAmount !== undefined) {
      const t = lockTrigger === undefined ? pos.lockTrigger : lockTrigger;
      const a = lockAmount === undefined ? pos.lockAmount : lockAmount;
      if ((t == null) !== (a == null)) throw badRequest('Set both the profit trigger and the amount to lock, or clear both', 'INVALID_LOCK');
      if (t != null && !(a > 0 && t > a)) throw badRequest('The profit trigger must be larger than the amount you lock in', 'INVALID_LOCK');
    }
    if (lockSteps !== undefined) {
      const ok = Array.isArray(lockSteps) && lockSteps.every((s, i) => s.keep > 0 && s.at > s.keep && (i === 0 || (s.at > lockSteps[i - 1].at && s.keep > lockSteps[i - 1].keep)));
      if (!ok) throw badRequest('Each profit rung must lock less than it needs, and rungs must rise', 'INVALID_LOCK');
    }
    if (stopLoss != null && (long ? tick(stopLoss) >= ltp : tick(stopLoss) <= ltp)) {
      throw badRequest(long ? 'For a long position the stop-loss must be below the current price' : 'For a short position the stop-loss must be above the current price', 'INVALID_SL');
    }
    if (target != null && (long ? tick(target) <= ltp : tick(target) >= ltp)) {
      throw badRequest(long ? 'For a long position the target must be above the current price' : 'For a short position the target must be below the current price', 'INVALID_TARGET');
    }

    const legs = await Order.find({ user: userId, symbol, status: 'OPEN', role: { $in: EXIT_ROLES } });
    const sl = legs.find((l) => l.role === 'STOPLOSS');
    const tg = legs.find((l) => l.role === 'TARGET');
    const qty = Math.abs(pos.netQty);
    const group = sl?.ocoGroup || tg?.ocoGroup || `pos-${pos._id}`;
    const common = { user: userId, symbol, side: long ? 'SELL' : 'BUY', qty, ocoGroup: group, tradingDay: this.marketStatus().istDate };
    const apply = async (leg, role, value, fields) => {
      if (value === undefined) {
        if (leg && leg.qty !== qty) {
          leg.qty = qty; // follow the position size
          await leg.save();
          this.#addToBook(leg.toObject());
        }
        return;
      }
      if (value === null) return leg && this.#cancel(leg, 'Removed by user');
      if (leg) {
        Object.assign(leg, fields(tick(value)), { qty });
        await leg.save();
        this.#addToBook(leg.toObject());
      } else {
        const created = new Order({ ...common, role, ...fields(tick(value)) });
        await created.save();
        this.#addToBook(created.toObject());
      }
    };
    await apply(sl, 'STOPLOSS', stopLoss, (v) => ({ orderType: 'SL_M', triggerPrice: v }));
    await apply(tg, 'TARGET', target, (v) => ({ orderType: 'LIMIT', price: v }));

    if (trailPct !== undefined) {
      pos.trailPct = trailPct;
      await pos.save();
      if (trailPct == null) this.trailing.get(symbol)?.delete(String(pos._id));
      else {
        this.#watchTrail(pos);
        // A trailing stop needs a stop to move: start it at the chosen distance if there is none.
        const hasSl = stopLoss != null || (stopLoss === undefined && sl);
        if (!hasSl) {
          const start = tick(long ? ltp * (1 - trailPct / 100) : ltp * (1 + trailPct / 100));
          await apply(undefined, 'STOPLOSS', start, (v) => ({ orderType: 'SL_M', triggerPrice: v }));
        }
      }
    }
    if (lockSteps !== undefined) {
      pos.lockSteps = lockSteps.map(({ at, keep }) => ({ at, keep }));
      await pos.save();
      this.#watchTrail(pos);
    }
    if (lockTrigger !== undefined || lockAmount !== undefined) {
      if (lockTrigger !== undefined) pos.lockTrigger = lockTrigger;
      if (lockAmount !== undefined) pos.lockAmount = lockAmount;
      if (lockRatio !== undefined) pos.lockRatio = lockRatio;
      await pos.save();
      if (pos.lockTrigger != null) this.#watchTrail(pos);
    }
    this.emit('update', { userId: String(userId), kind: 'order', message: `Stop loss and target updated for ${symbol}` });
    return this.exitsFor(userId, symbol);
  }

  /** Current stop loss, target and trailing distance of an open position. */
  async exitsFor(userId, symbol) {
    const pos = await Position.findOne({ user: userId, symbol, status: 'OPEN' }).lean();
    const legs = await Order.find({ user: userId, symbol, status: 'OPEN', role: { $in: EXIT_ROLES } }).lean();
    return {
      symbol,
      stopLoss: legs.find((l) => l.role === 'STOPLOSS')?.triggerPrice ?? null,
      target: legs.find((l) => l.role === 'TARGET')?.price ?? null,
      trailPct: pos?.trailPct ?? null,
      lockTrigger: pos?.lockTrigger ?? null,
      lockAmount: pos?.lockAmount ?? null,
    };
  }

  #watchTrail(pos) {
    if (!this.trailing.has(pos.symbol)) this.trailing.set(pos.symbol, new Map());
    this.trailing.get(pos.symbol).set(String(pos._id), { user: pos.user, busy: false });
  }

  /**
   * On each tick, pull protective stops closer behind the price. They never move away from it.
   * Two kinds, and the better one wins: a % trail, and the profit lock (once the open profit reaches
   * `lockTrigger` rupees the stop locks in `lockAmount`, then follows `lockTrigger - lockAmount` behind the best profit).
   */
  #trail(tick) {
    const watchers = this.trailing.get(tick.symbol);
    if (!watchers?.size) return;
    for (const [posId, w] of watchers) {
      if (w.busy) continue;
      w.busy = true;
      this.locks
        .run(String(w.user), () => this.#trailOne(posId, tick.ltp, watchers))
        .catch((err) => logger.error(`trail ${posId} failed`, err))
        .finally(() => {
          w.busy = false;
        });
    }
  }

  async #trailOne(posId, ltp, watchers) {
    const pos = await Position.findById(posId);
    if (!pos || pos.status !== 'OPEN' || (pos.trailPct == null && pos.lockTrigger == null && !pos.lockSteps?.length && !pos.stepPrices?.length)) {
      watchers.delete(posId);
      return;
    }
    const long = pos.netQty > 0;
    const qty = Math.abs(pos.netQty);
    const wants = [];
    if (pos.trailPct != null) wants.push(roundToTick(long ? ltp * (1 - pos.trailPct / 100) : ltp * (1 + pos.trailPct / 100)));
    // Stops that lock in profit (the rupee lock and the target ladder) must still be a gain after charges.
    const floorPer = (LOCK_CHARGES_MULT * roundTripCharges({ qty, price: pos.avgPrice, segment: pos.segment })) / qty;
    const chargesFloor = roundToTick(long ? pos.avgPrice + floorPer : pos.avgPrice - floorPer);
    const lockStop = (w) => (long ? Math.max(w, chargesFloor) : Math.min(w, chargesFloor));
    const profit = (long ? ltp - pos.avgPrice : pos.avgPrice - ltp) * qty;
    if (pos.lockTrigger != null && profit >= pos.lockTrigger) {
      // With a ratio the lock climbs by that share of every extra rupee; without one it trails the best profit.
      const locked = pos.lockRatio != null ? pos.lockAmount + pos.lockRatio * (profit - pos.lockTrigger) : Math.max(pos.lockAmount, profit - (pos.lockTrigger - pos.lockAmount));
      const per = locked / qty;
      wants.push(lockStop(roundToTick(long ? pos.avgPrice + per : pos.avgPrice - per)));
    }
    // The rupee ladder: past each rung the stop keeps that rung's amount and then follows (at - keep) behind the best profit.
    const rung = [...(pos.lockSteps || [])].reverse().find((s) => profit >= s.at);
    if (rung) {
      const per = Math.max(rung.keep, profit - (rung.at - rung.keep)) / qty;
      wants.push(lockStop(roundToTick(long ? pos.avgPrice + per : pos.avgPrice - per)));
    }
    for (const step of pos.stepPrices || []) {
      if (long ? ltp > step : ltp < step) wants.push(lockStop(roundToTick(pos.avgPrice + STEP_KEEP * (step - pos.avgPrice))));
    }
    if (!wants.length) return;
    const want = long ? Math.max(...wants) : Math.min(...wants);
    if (!(long ? want < ltp : want > ltp)) return;
    const sl = await Order.findOne({ user: pos.user, symbol: pos.symbol, status: 'OPEN', role: 'STOPLOSS' });
    if (!sl) {
      const tg = await Order.findOne({ user: pos.user, symbol: pos.symbol, status: 'OPEN', role: 'TARGET' });
      const created = new Order({
        user: pos.user,
        symbol: pos.symbol,
        side: long ? 'SELL' : 'BUY',
        orderType: 'SL_M',
        triggerPrice: want,
        role: 'STOPLOSS',
        qty,
        ocoGroup: tg?.ocoGroup || `pos-${pos._id}`,
        tradingDay: this.marketStatus().istDate,
      });
      await created.save();
      this.#addToBook(created.toObject());
      this.emit('update', { userId: String(pos.user), kind: 'order', order: created.toJSON() });
      return;
    }
    if (long ? want <= sl.triggerPrice : want >= sl.triggerPrice) return;
    sl.triggerPrice = want;
    await sl.save();
    this.#addToBook(sl.toObject());
    this.emit('update', { userId: String(pos.user), kind: 'order', order: sl.toJSON() });
  }

  async #place(userId, input) {
    const symbol = String(input.symbol || '').toUpperCase();
    const side = input.side;
    const orderType = input.orderType;
    const qty = Number(input.qty);

    const option = isOptionSymbol(symbol);
    if (!isTradable(symbol) && !option) throw badRequest('Only Nifty 50 stocks and Nifty index options can be traded', 'INVALID_SYMBOL');
    if (!['BUY', 'SELL'].includes(side)) throw badRequest('side must be BUY or SELL');
    if (!['MARKET', 'LIMIT'].includes(orderType)) throw badRequest('orderType must be MARKET or LIMIT');
    if (!Number.isInteger(qty) || qty < 1) throw badRequest('Quantity must be a whole number of at least 1', 'INVALID_QTY');
    if (qty > this.config.maxOrderQty) throw badRequest(`Quantity cannot exceed ${this.config.maxOrderQty}`, 'INVALID_QTY');
    if (option) {
      const lot = this.#lotSize(symbol);
      if (qty % lot !== 0) throw badRequest(`Options trade in lots of ${lot}`, 'INVALID_QTY');
    }

    if (option && !this.market.getLtp(symbol)) await this.market.watchOption?.(symbol); // start the contract's price stream
    const ltp = this.market.getLtp(symbol);
    if (!ltp) throw unavailable('No live price for this stock yet. Try again in a moment.', 'NO_PRICE');

    const segment = option ? 'OPT' : 'EQ';
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
      source: input.source === 'AUTO' ? 'AUTO' : 'MANUAL', // the HTTP schema strips this, so only server code can set it
      ltpAtPlacement: ltp,
      tradingDay: status.istDate,
    });

    const position = await Position.findOne({ user: userId, symbol, status: 'OPEN' });
    const openingQty = this.#openingQty(position, side, qty);

    let reject = null;
    if (option && openingQty > 0 && side === 'SELL') reject = 'Options are bought to open here. Writing (selling) options is not allowed.';
    else if (this.config.enforceMarketHours && !status.isOpen) reject = 'Market is closed. NSE trades 09:15 to 15:30 IST, Monday to Friday.';
    else if (this.config.enforceMarketHours && status.afterSquareOff && openingQty > 0) {
      reject = 'New intraday positions are not allowed after the 15:15 IST square-off.';
    } else if (openingQty > 0) {
      const required = this.#marginFor(openingQty, ref, segment) + calculateCharges({ side, qty, price: ref, segment }).total;
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

    order.blockedMargin = round2(this.#marginFor(openingQty, price, segment));
    await order.save();
    this.#addToBook(order.toObject());
    this.emit('update', { userId: String(userId), kind: 'order', order: order.toJSON() });
    return { order, trades: [] };
  }

  async #fillResting(orderId, ltp, symbol) {
    const order = await Order.findById(orderId);
    if (!order || order.status !== 'OPEN') {
      // The order is gone (e.g. an account reset): drop it from the book so it is not re-checked on every tick.
      this.#removeFromBook(order?.symbol ?? symbol, orderId);
      return null;
    }
    const price = this.market.getLtp(order.symbol) ?? ltp;
    if (!isTriggered(order, price)) return null; // price moved back before we got the lock

    if (order.role === 'ENTRY') {
      const position = await Position.findOne({ user: order.user, symbol: order.symbol, status: 'OPEN' });
      const openingQty = this.#openingQty(position, order.side, order.qty);
      if (openingQty > 0) {
        const funds = await getFunds(order.user, this.config.startingBalance);
        const required = this.#marginFor(openingQty, price, order.segment) + calculateCharges({ side: order.side, qty: order.qty, price, segment: order.segment }).total;
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
    const segment = isOptionSymbol(symbol) ? 'OPT' : 'EQ';
    const now = this.now();
    const tradingDay = this.marketStatus().istDate;
    const charges = calculateCharges({ side, qty, price, segment });
    const trades = [];
    let remaining = qty;
    let pnlDelta = 0;

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
      if (position.status === 'CLOSED') position = null;
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
        const d = (await TradeDefaults.findOne({ user: userId }).lean()) ?? TRADE_DEFAULTS;
        if (d.lockEnabled && d.lockTrigger > d.lockAmount) {
          position.lockTrigger = d.lockTrigger;
          position.lockAmount = d.lockAmount;
          position.lockRatio = d.lockRatio ?? null;
        }
      }
      this.#bookSide(position, side, remaining, price);
      position.charges = round2(position.charges + ch.total);
      position.margin = round2(position.margin + this.#marginFor(remaining, price, segment));
      await position.save();
      if (position.lockTrigger != null) this.#watchTrail(position);
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
    if (!stillOpen) {
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
    const common = { user: entry.user, symbol: entry.symbol, side: exitSide, qty, source: entry.source, parentOrder: entry._id, ocoGroup: String(entry._id), tradingDay };
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
      segment: isOptionSymbol(order.symbol) ? 'OPT' : 'EQ',
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

  // Shares are bought on intraday leverage; an option buyer pays the whole premium and nothing more can be lost.
  #marginFor(qty, price, segment = 'EQ') {
    return segment === 'OPT' ? qty * price : (qty * price) / this.config.misLeverage;
  }

  #lotSize(symbol) {
    return this.market.lotSize?.(symbol) ?? this.config.niftyLotSize ?? DEFAULT_LOT_SIZE;
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
