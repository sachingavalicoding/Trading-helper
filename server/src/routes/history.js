import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { RETAIN_DAYS } from '../market/historyStore.js';
import { UNDERLYING } from '../options/symbols.js';

const syncSchema = z.object({ days: z.coerce.number().int().min(5).max(RETAIN_DAYS).default(RETAIN_DAYS), live: z.boolean().default(true) });

export const HISTORY_NOTE = 'Candles are saved once from Upstox and kept for three months. The studies and Review read them from here; charts and live prices still use Upstox directly. The button adds the days that are missing and today so far, and drops the oldest days beyond three months; after the close each evening the day is completed on its own.';

export function historyRoutes({ history }) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ saved: await history.store.summary(), liveAt: await history.store.liveAt(UNDERLYING), job: history.status(), simulated: Boolean(history.market.provider.isSimulated), note: HISTORY_NOTE });
  });

  router.post('/sync', validate(syncSchema), (req, res) => {
    history.start({ days: req.body.days, live: req.body.live });
    res.status(202).json({ job: history.status() });
  });

  return router;
}
