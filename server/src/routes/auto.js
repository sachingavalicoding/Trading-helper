import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AutoLog, AutoSettings, ScanIdea } from '../models/index.js';
import { summarizeLog } from '../auto/logSummary.js';
import { loadRules } from '../models/TradeDefaults.js';

export const AUTO_DISCLAIMER = 'Auto trading places virtual (paper) orders only. It follows the scanner\'s rules and does not guarantee profit. Not investment advice.';

const patch = z
  .object({
    enabled: z.boolean(),
    earlyNews: z.boolean(),
    minScore: z.coerce.number().min(60).max(100),
    maxOpen: z.coerce.number().int().min(1).max(10),
    riskPct: z.coerce.number().min(0.1).max(3),
    dailyLossPct: z.coerce.number().min(0.5).max(10),
    maxShares: z.coerce.number().int().min(0).max(100000),
    maxTradeAmount: z.coerce.number().min(1000).max(100_000_000),
  })
  .partial();

export function autoRoutes({ autoTrader }) {
  const dayOf = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const router = Router();
  const view = async (userId, doc) => {
    const s = doc || new AutoSettings({ user: userId });
    return {
      settings: { enabled: s.enabled, minScore: s.minScore, maxOpen: s.maxOpen, riskPct: s.riskPct, dailyLossPct: s.dailyLossPct, maxShares: s.maxShares, maxTradeAmount: s.maxTradeAmount, earlyNews: s.earlyNews !== false },
      rules: await loadRules(userId, 'EQ'),
      today: await autoTrader.todaySummary(userId),
      disclaimer: AUTO_DISCLAIMER,
    };
  };

  router.get('/', async (req, res) => {
    res.json(await view(req.userId, await AutoSettings.findOne({ user: req.userId })));
  });

  router.put('/', validate(patch), async (req, res) => {
    const doc = await AutoSettings.findOneAndUpdate({ user: req.userId }, { $set: req.body, $setOnInsert: { user: req.userId } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    res.json(await view(req.userId, doc));
  });

  // The day's auto log: every decision with its numbers, plus a summary to review in the evening.
  router.get('/log', async (req, res) => {
    const parsed = dayOf.safeParse(req.query.day ?? autoTrader.engine.marketStatus().istDate);
    if (!parsed.success) return res.status(400).json({ error: { message: 'day must look like 2026-10-26' } });
    const day = parsed.data;
    const entries = await AutoLog.find({ user: req.userId, day, segment: { $ne: 'OPT' } }).sort({ decidedAt: 1 }).lean();
    const ids = entries.map((e) => e.idea).filter(Boolean);
    const ideas = new Map((ids.length ? await ScanIdea.find({ _id: { $in: ids } }, 'status').lean() : []).map((i) => [String(i._id), i]));
    res.json({ day, summary: summarizeLog(entries, ideas), entries: entries.map(({ card, ...e }) => ({ ...e, checks: card?.checks })) });
  });

  return router;
}
