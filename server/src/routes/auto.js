import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AutoSettings } from '../models/index.js';

export const AUTO_DISCLAIMER = 'Auto trading places virtual (paper) orders only. It follows the scanner\'s rules and does not guarantee profit. Not investment advice.';

const patch = z
  .object({
    enabled: z.boolean(),
    minScore: z.coerce.number().min(60).max(100),
    maxOpen: z.coerce.number().int().min(1).max(10),
    riskPct: z.coerce.number().min(0.1).max(3),
    dailyLossPct: z.coerce.number().min(0.5).max(10),
  })
  .partial();

export function autoRoutes({ autoTrader }) {
  const router = Router();
  const view = async (userId, doc) => {
    const s = doc || new AutoSettings({ user: userId });
    return {
      settings: { enabled: s.enabled, minScore: s.minScore, maxOpen: s.maxOpen, riskPct: s.riskPct, dailyLossPct: s.dailyLossPct },
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

  return router;
}
