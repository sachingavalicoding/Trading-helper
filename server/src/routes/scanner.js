import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { getFunds } from '../services/walletService.js';
import { sizePosition } from '../scanner/sizing.js';

export const SCANNER_DISCLAIMER = 'Rule-based ideas for learning. Not investment advice, and no idea is guaranteed to work.';

const query = z.object({ risk: z.coerce.number().min(0.1).max(5).default(1) });

export function scannerRoutes({ scanner, config }) {
  const router = Router();

  router.get('/', validate(query, 'query'), async (req, res) => {
    const riskPct = req.valid.risk;
    const [funds, done] = await Promise.all([getFunds(req.userId, config.startingBalance), scanner.doneToday()]);
    const { items, ...scan } = scanner.result;
    res.json({
      ...scan,
      warming: scanner.store.loadedCount < scanner.symbols.length,
      loaded: scanner.store.loadedCount,
      riskPct,
      capital: funds.balance,
      items: items.map((i) => ({
        ...i,
        size: sizePosition({ capital: funds.balance, riskPct, entry: i.entry, stopLoss: i.stopLoss, available: funds.available, leverage: config.misLeverage, maxQty: config.maxOrderQty }),
      })),
      done: done.map((d) => ({ id: String(d._id), symbol: d.symbol, setup: d.setup, side: d.side, entry: d.entry, stopLoss: d.stopLoss, target1: d.target1, status: d.status, exitPrice: d.exitPrice, closedAt: d.closedAt })),
      disclaimer: SCANNER_DISCLAIMER,
    });
  });

  // The pre-market plan: stocks worth watching today and the level to wait for.
  router.get('/plan', async (_req, res) => {
    res.json({ ...(await scanner.plan()), warming: scanner.store.loadedCount < scanner.symbols.length, disclaimer: SCANNER_DISCLAIMER });
  });

  return router;
}
