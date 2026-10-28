import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

const syncSchema = z.object({ days: z.coerce.number().int().min(5).max(365).default(365) });

export const HISTORY_NOTE = 'Candles are saved once from Upstox and kept for a year. The studies and Review read them from here; charts and live prices still use Upstox directly. After the close each evening the day is added and anything older than a year is removed.';

export function historyRoutes({ history }) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ saved: await history.store.summary(), job: history.status(), simulated: Boolean(history.market.provider.isSimulated), note: HISTORY_NOTE });
  });

  router.post('/sync', validate(syncSchema), (req, res) => {
    history.start({ days: req.body.days });
    res.status(202).json({ job: history.status() });
  });

  return router;
}
