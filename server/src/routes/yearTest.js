import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export const YEAR_TEST_NOTE = 'Plays ONE thing over months of the year candle files, fast (the engines Learn uses, not the full Replay). Nothing is tuned on these days and no setting is changed. Options premiums here are ESTIMATED by the model (real option prices are saved for about 30 days only). Shares: each fill 0.05% worse; options: 0.5% worse. Charges are taken off every trade. At the end it is checked against the full Replay on the newest days both have.';

const startSchema = z.object({
  side: z.enum(['shares', 'options']),
  what: z.enum(['score', 'combo']),
  entry: z.string().max(40).default('all'),
  combo: z.string().max(80).nullable().default(null),
  months: z.coerce.number().int().default(6),
  maxTrades: z.coerce.number().int().nullable().default(null),
  with: z.array(z.string().max(80)).max(2).default([]),
});

export function yearTestRoutes({ yearTest }) {
  const router = Router();
  router.get('/', async (req, res) => res.json({ ...(await yearTest.view(req.userId)), note: YEAR_TEST_NOTE }));
  router.post('/start', validate(startSchema), async (req, res) => res.status(202).json(await yearTest.start(req.userId, req.body)));
  router.post('/stop', async (req, res) => res.json(await yearTest.stop(req.userId)));
  router.post('/resume', async (req, res) => res.status(202).json(await yearTest.resume(req.userId)));
  router.post('/check', async (req, res) => res.status(202).json(await yearTest.check(req.userId)));
  return router;
}
