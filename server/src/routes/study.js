import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { badRequest, notFound } from '../utils/errors.js';

export const SHARES_NOTE = 'This replays the scanner on past 1-minute candles of the Nifty 50, sized to your Account stop. There is no order book in the replay, and it exits with your profit ladder or a fixed rupee target, as you choose, so read it for which setups, hours and sides pay more than for exact rupees. Past results do not promise future ones.';

export const STUDY_NOTE = 'This is a replay of past Nifty candles as paper trades of one lot. Option prices are estimated, not recorded, so the rupee amounts are a guide. Past results do not promise future ones.';

const KINDS = ['options', 'shares'];
const runSchema = z.object({
  days: z.coerce.number().int().min(1).max(60).optional(),
  iv: z.coerce.number().min(0.08).max(0.4).default(0.14),
  exit: z.enum(['lock', 'target']).default('lock'),
  target: z.coerce.number().min(100).max(100000).default(1000),
  fixedLots: z.coerce.number().int().min(0).max(20).default(0),
});
const MAX_DAYS = { options: 60, shares: 15 }; // a share replay runs the whole scanner on 50 stocks, so it is kept short

export function studyRoutes({ study }) {
  const router = Router();

  router.param('kind', (req, _res, next, kind) => (KINDS.includes(kind) ? next() : next(notFound('No such study'))));

  router.get('/:kind', async (req, res) => {
    const { kind } = req.params;
    res.json({ status: study.status(req.userId, kind), result: await study.latest(req.userId, kind), note: kind === 'shares' ? SHARES_NOTE : STUDY_NOTE });
  });

  router.post('/:kind', validate(runSchema), (req, res) => {
    const { kind } = req.params;
    if (req.body.days != null && req.body.days > MAX_DAYS[kind]) throw badRequest(`days must be 1 to ${MAX_DAYS[kind]}`, 'VALIDATION');
    study.start(req.userId, kind, req.body);
    res.status(202).json({ status: study.status(req.userId, kind) });
  });

  return router;
}
