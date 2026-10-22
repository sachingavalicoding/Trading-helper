import { Router } from 'express';
import { z } from 'zod';
import { Order, Position, Trade } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { getFunds } from '../services/walletService.js';
import { getDashboard } from '../services/analytics.js';

const price = z.coerce.number().positive().optional();
const orderSchema = z
  .object({
    symbol: z.string().trim().min(1).max(20),
    side: z.enum(['BUY', 'SELL']),
    orderType: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
    qty: z.coerce.number().int('must be a whole number').min(1),
    price,
    stopLoss: price,
    target: price,
  })
  .refine((o) => o.orderType !== 'LIMIT' || o.price, { message: 'price is required for LIMIT orders', path: ['price'] });

const modifySchema = z.object({ price: z.coerce.number().positive() });

const listQuery =z.object({
  status: z.enum(['OPEN', 'FILLED', 'CANCELLED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const positionQuery = z.object({ status: z.enum(['OPEN', 'CLOSED', 'ALL']).default('ALL'), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export function tradingRoutes({ engine, market, config }) {
  const router = Router();

  router.get('/wallet', async (req, res) => {
    res.json(await getFunds(req.userId, config.startingBalance));
  });

  router.post('/wallet/reset', async (req, res) => {
    await engine.resetAccount(req.userId);
    res.json(await getFunds(req.userId, config.startingBalance));
  });

  router.get('/orders', validate(listQuery, 'query'), async (req, res) => {
    const filter = { user: req.userId };
    if (req.valid.status) filter.status = req.valid.status;
    res.json({ orders: await Order.find(filter).sort({ createdAt: -1 }).limit(req.valid.limit) });
  });

  router.post('/orders', validate(orderSchema), async (req, res) => {
    const { order, trades } = await engine.placeOrder(req.userId, req.body);
    res.status(order.status === 'REJECTED' ? 200 : 201).json({ order, trades });
  });

  router.patch('/orders/:id', validate(modifySchema), async (req, res) => {
    res.json({ order: await engine.modifyOrder(req.userId, req.params.id, req.body.price) });
  });

  router.delete('/orders/:id', async (req, res) => {
    res.json({ order: await engine.cancelOrder(req.userId, req.params.id) });
  });

  router.get('/positions', validate(positionQuery, 'query'), async (req, res) => {
    const filter = { user: req.userId };
    if (req.valid.status !== 'ALL') filter.status = req.valid.status;
    if (req.valid.day) filter.tradingDay = req.valid.day;
    const positions = await Position.find(filter).sort({ status: -1, updatedAt: -1 }).limit(500);
    res.json({
      positions: positions.map((p) => ({ ...p.toJSON(), ltp: market.getLtp(p.symbol) })),
    });
  });

  router.post('/positions/exit-all', async (req, res) => {
    res.json(await engine.squareOff({ userId: req.userId, reason: 'Exit all' }));
  });

  router.post('/positions/:symbol/exit', async (req, res) => {
    const { order, trades } = await engine.exitPosition(req.userId, req.params.symbol.toUpperCase());
    res.json({ order, trades });
  });

  router.get('/trades', validate(listQuery, 'query'), async (req, res) => {
    res.json({ trades: await Trade.find({ user: req.userId }).sort({ executedAt: -1 }).limit(req.valid.limit) });
  });

  router.get('/dashboard', async (req, res) => {
    res.json(await getDashboard(req.userId, { startingBalance: (await getFunds(req.userId, config.startingBalance)).startingBalance, ltpOf: (s) => market.getLtp(s) }));
  });

  return router;
}
