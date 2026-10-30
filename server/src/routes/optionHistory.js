import { Router } from 'express';

export const OPTION_HISTORY_NOTE = 'Real option premiums (1-minute candles with open interest) are saved each evening for the contracts near the money, and the last 30 trading days are kept. Upstox lists only live contracts, so the days after the first evening fill one at a time, and the first run also reads back the few days the contracts still listed have (marked as backfilled, without the contracts that have already expired). The studies still estimate premiums until they are changed to read these.';

export function optionHistoryRoutes({ optionHistory }) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ saved: await optionHistory.store.summary(), job: optionHistory.status(), simulated: Boolean(optionHistory.market.provider.isSimulated), note: OPTION_HISTORY_NOTE });
  });

  router.post('/sync', (_req, res) => {
    optionHistory.start({ force: true });
    res.status(202).json({ job: optionHistory.status() });
  });

  router.post('/backfill', (_req, res) => {
    optionHistory.startBackfill();
    res.status(202).json({ job: optionHistory.status() });
  });

  return router;
}
