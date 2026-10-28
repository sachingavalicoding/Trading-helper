import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export const STUDY_NOTE = 'This is a replay of past Nifty candles as paper trades of one lot. Option prices are estimated, not recorded, so the rupee amounts are a guide. Past results do not promise future ones.';

const runSchema = z.object({
  days: z.coerce.number().int().min(5).max(60).default(20),
  iv: z.coerce.number().min(0.08).max(0.4).default(0.14),
});

export function studyRoutes({ study }) {
  const router = Router();

  router.get('/options', async (req, res) => {
    res.json({ status: study.status(req.userId), result: await study.latest(req.userId), note: STUDY_NOTE });
  });

  router.post('/options', validate(runSchema), (req, res) => {
    study.start(req.userId, req.body);
    res.status(202).json({ status: study.status(req.userId) });
  });

  return router;
}
