import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { getFunds } from '../services/walletService.js';
import { sizePosition } from '../scanner/sizing.js';
import { summarizeIdeas } from '../scanner/stats.js';
import { ScanIdea } from '../models/index.js';

export const SCANNER_DISCLAIMER = 'Rule-based ideas for learning. Not investment advice, and no idea is guaranteed to work.';

const query = z.object({ risk: z.coerce.number().min(0.1).max(5).default(1), maxAmount: z.coerce.number().min(1000).max(100_000_000).optional() });

export function scannerRoutes({ scanner, config }) {
  const router = Router();

  router.get('/', validate(query, 'query'), async (req, res) => {
    const riskPct = req.valid.risk;
    const [funds, done, finished] = await Promise.all([
      getFunds(req.userId, config.startingBalance),
      scanner.doneToday(),
      ScanIdea.find({ status: { $ne: 'OPEN' } }, 'setup side status entry stopLoss exitPrice score createdAt').lean(),
    ]);
    // What ideas of each score band really did, so a high score is never mistaken for a promise.
    const calibration = Object.fromEntries(summarizeIdeas(finished.map((i) => ({ ...i, openedAt: i.createdAt }))).byScore.map((r) => [r.key, { count: r.count, winRate: r.winRate, avgR: r.avgR, enough: r.enough }]));
    const { items, rejected, ...scan } = scanner.result;
    res.json({
      ...scan,
      warming: scanner.store.loadedCount < scanner.symbols.length,
      loaded: scanner.store.loadedCount,
      calibration,
      rejected: rejected ?? [],
      riskPct,
      capital: funds.balance,
      items: items.map((i) => ({
        ...i,
        size: sizePosition({ capital: funds.balance, riskPct, entry: i.entry, stopLoss: i.stopLoss, available: funds.available, leverage: config.misLeverage, maxQty: config.maxOrderQty, maxAmount: req.valid.maxAmount }),
      })),
      done: done.map((d) => ({ id: String(d._id), symbol: d.symbol, setup: d.setup, side: d.side, entry: d.entry, stopLoss: d.stopLoss, target1: d.target1, status: d.status, exitPrice: d.exitPrice, closedAt: d.closedAt })),
      disclaimer: SCANNER_DISCLAIMER,
    });
  });

  // How finished ideas ended, by setup, side, hour and score.
  router.get('/stats', async (_req, res) => {
    const ideas = await ScanIdea.find({ status: { $ne: 'OPEN' } }, 'setup side status entry stopLoss exitPrice score createdAt').lean();
    res.json({ ...summarizeIdeas(ideas.map((i) => ({ ...i, openedAt: i.createdAt }))), disclaimer: SCANNER_DISCLAIMER });
  });

  // The pre-market plan: stocks worth watching today and the level to wait for.
  router.get('/plan', async (_req, res) => {
    res.json({ ...(await scanner.plan()), warming: scanner.store.loadedCount < scanner.symbols.length, disclaimer: SCANNER_DISCLAIMER });
  });

  return router;
}
