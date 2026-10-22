import { Router } from 'express';
import { Position } from '../models/index.js';
import { isTradable } from '../market/instruments.js';
import { analyze, positionAdvice } from '../signals/analyze.js';
import { signalStats } from '../signals/tracker.js';
import { notFound } from '../utils/errors.js';

export const SIGNAL_DISCLAIMER = 'Rule-based reading of the chart for learning. Not investment advice, and no signal is guaranteed to work.';

export function signalRoutes({ market, tracker }) {
  const router = Router();

  router.get('/stats', async (req, res) => {
    res.json({ ...(await signalStats(req.userId)), disclaimer: SIGNAL_DISCLAIMER });
  });

  router.get('/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!isTradable(symbol)) throw notFound('Signals are only available for Nifty 50 stocks');
    const [c5, c15, position] = await Promise.all([
      market.getCandles(symbol, '5m'),
      market.getCandles(symbol, '15m'),
      Position.findOne({ user: req.userId, symbol, status: 'OPEN' }).lean(),
    ]);
    const signal = analyze({ symbol, tick: market.getTick(symbol), c5, c15, niftyChangePct: market.getTick('NIFTY 50')?.changePct ?? null });
    if (signal.plan && tracker) await tracker.record(req.userId, signal);
    res.json({ ...signal, position: positionAdvice(signal, position?.netQty), disclaimer: SIGNAL_DISCLAIMER });
  });

  return router;
}
