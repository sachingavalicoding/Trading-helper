import { Router } from 'express';
import { z } from 'zod';
import { Order, Position, Trade, TradeDefaults } from '../models/index.js';
import { rulesFor } from '../models/TradeDefaults.js';
import { validate } from '../middleware/validate.js';
import { addFunds, getFunds } from '../services/walletService.js';
import { getDashboard } from '../services/analytics.js';
import { parseOptionSymbol, optionLabel } from '../options/symbols.js';

const price = z.coerce.number().positive().optional();
const orderSchema = z
  .object({
    symbol: z.string().trim().min(1).max(30),
    side: z.enum(['BUY', 'SELL']),
    orderType: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
    qty: z.coerce.number().int('must be a whole number').min(1),
    price,
    stopLoss: price,
    target: price,
  })
  .refine((o) => o.orderType !== 'LIMIT' || o.price, { message: 'price is required for LIMIT orders', path: ['price'] });

// A number sets it, null removes it, leaving a field out keeps it.
const exitsSchema = z.object({
  stopLoss: z.coerce.number().positive().nullable().optional(),
  target: z.coerce.number().positive().nullable().optional(),
  trailPct: z.coerce.number().nullable().optional(),
  lockTrigger: z.coerce.number().positive().nullable().optional(),
  lockAmount: z.coerce.number().positive().nullable().optional(),
});
const rulesSchema = z.object({
  stopLoss: z.coerce.number().min(0).max(10_000_000),
  lockStart: z.coerce.number().min(0).max(10_000_000),
  lockGap: z.coerce.number().min(1).max(10_000_000),
}).partial();
const defaultsSchema = z.object({ shares: rulesSchema.optional(), options: rulesSchema.optional() });
// Shares and Nifty options are kept apart on every list: shares by default, options with ?segment=OPT.
const segment = z.enum(['EQ', 'OPT', 'ALL']).default('EQ');
const bySegment = (seg) => (seg === 'OPT' ? { segment: 'OPT' } : seg === 'EQ' ? { segment: { $ne: 'OPT' } } : {});
const listQuery = z.object({
  status: z.enum(['OPEN', 'FILLED', 'CANCELLED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  segment,
});
const addFundsSchema = z.object({ amount: z.coerce.number().min(1000).max(10_000_000) });
const positionQuery = z.object({ status: z.enum(['OPEN', 'CLOSED', 'ALL']).default('ALL'), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), segment });
const dashboardQuery = z.object({ segment });
// An option's symbol says its strike, expiry and side; screens get those pre-split.
const withOption = (symbol) => {
  const o = parseOptionSymbol(symbol);
  return o ? { option: o, label: optionLabel(symbol) } : {};
};

export function tradingRoutes({ engine, market, config }) {
  const router = Router();

  router.get('/wallet', async (req, res) => {
    res.json(await getFunds(req.userId, config.startingBalance));
  });

  // Top up the virtual wallet. Nothing real moves: it is a paper balance, and the starting capital rises with it so P&L is unchanged.
  router.post('/wallet/add-funds', validate(addFundsSchema), async (req, res) => {
    await addFunds(req.userId, req.body.amount, config.startingBalance);
    res.json(await getFunds(req.userId, config.startingBalance));
  });

  router.post('/wallet/reset', async (req, res) => {
    await engine.resetAccount(req.userId);
    res.json(await getFunds(req.userId, config.startingBalance));
  });

  router.get('/orders', validate(listQuery, 'query'), async (req, res) => {
    const filter = { user: req.userId, ...bySegment(req.valid.segment) };
    if (req.valid.status) filter.status = req.valid.status;
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(req.valid.limit);
    res.json({ orders: orders.map((o) => ({ ...o.toJSON(), ...withOption(o.symbol) })) });
  });

  router.post('/orders', validate(orderSchema), async (req, res) => {
    const { order, trades } = await engine.placeOrder(req.userId, req.body);
    res.status(order.status === 'REJECTED' ? 200 : 201).json({ order, trades });
  });

  router.delete('/orders/:id', async (req, res) => {
    res.json({ order: await engine.cancelOrder(req.userId, req.params.id) });
  });

  router.get('/positions', validate(positionQuery, 'query'), async (req, res) => {
    const filter = { user: req.userId, ...bySegment(req.valid.segment) };
    if (req.valid.status !== 'ALL') filter.status = req.valid.status;
    if (req.valid.day) filter.tradingDay = req.valid.day;
    const positions = await Position.find(filter).sort({ status: -1, updatedAt: -1 }).limit(500);
    const open = positions.filter((p) => p.status === 'OPEN').map((p) => p.symbol);
    const legs = open.length ? await Order.find({ user: req.userId, symbol: { $in: open }, status: 'OPEN', role: { $in: ['STOPLOSS', 'TARGET'] } }).lean() : [];
    res.json({
      positions: positions.map((p) => ({
        ...p.toJSON(),
        ...withOption(p.symbol),
        ltp: market.getLtp(p.symbol),
        stopLoss: legs.find((l) => l.symbol === p.symbol && l.role === 'STOPLOSS')?.triggerPrice ?? null,
        target: legs.find((l) => l.symbol === p.symbol && l.role === 'TARGET')?.price ?? null,
      })),
    });
  });

  router.put('/positions/:symbol/exits', validate(exitsSchema), async (req, res) => {
    res.json(await engine.setExits(req.userId, req.params.symbol.toUpperCase(), req.body));
  });

  const defaultsView = (doc) => ({ shares: rulesFor(doc, 'EQ'), options: rulesFor(doc, 'OPT') });

  router.get('/trade-defaults', async (req, res) => {
    res.json(defaultsView(await TradeDefaults.findOne({ user: req.userId }).lean()));
  });

  router.put('/trade-defaults', validate(defaultsSchema), async (req, res) => {
    const next = defaultsView(await TradeDefaults.findOne({ user: req.userId }).lean());
    for (const key of ['shares', 'options']) {
      Object.assign(next[key], req.body[key]);
      if (next[key].lockStart > 0 && next[key].lockStart <= next[key].lockGap) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: `For ${key}, the profit where the lock starts must be larger than the gap it follows behind` } });
      }
    }
    const doc = await TradeDefaults.findOneAndUpdate({ user: req.userId }, { $set: next, $setOnInsert: { user: req.userId } }, { upsert: true, new: true, runValidators: true });
    res.json(defaultsView(doc));
  });

  router.get('/positions/:symbol/exits', async (req, res) => {
    res.json(await engine.exitsFor(req.userId, req.params.symbol.toUpperCase()));
  });

  router.post('/positions/exit-all', async (req, res) => {
    const seg = segment.parse(req.query.segment ?? 'ALL');
    res.json(await engine.squareOff({ userId: req.userId, reason: 'Exit all', segment: seg }));
  });

  router.post('/positions/:symbol/exit', async (req, res) => {
    const { order, trades } = await engine.exitPosition(req.userId, req.params.symbol.toUpperCase());
    res.json({ order, trades });
  });

  router.get('/trades', validate(listQuery, 'query'), async (req, res) => {
    const trades = await Trade.find({ user: req.userId, ...bySegment(req.valid.segment) }).sort({ executedAt: -1 }).limit(req.valid.limit);
    res.json({ trades: trades.map((t) => ({ ...t.toJSON(), ...withOption(t.symbol) })) });
  });

  router.get('/dashboard', validate(dashboardQuery, 'query'), async (req, res) => {
    const { segment: seg } = req.valid;
    // The share dashboard's curve starts from the wallet's starting balance; an options-only curve starts from nothing.
    const startingBalance = seg === 'OPT' ? 0 : (await getFunds(req.userId, config.startingBalance)).startingBalance;
    res.json(await getDashboard(req.userId, { startingBalance, ltpOf: (s) => market.getLtp(s), segment: seg }));
  });

  return router;
}
