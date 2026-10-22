import { Router } from 'express';
import { z } from 'zod';
import { NIFTY50, INDICES, getInstrument } from '../market/instruments.js';
import { validate } from '../middleware/validate.js';
import { notFound } from '../utils/errors.js';

const candleQuery = z.object({ interval: z.enum(['1m', '5m', '15m']).default('1m') });

export function marketRoutes({ market }) {
  const router = Router();

  router.get('/instruments', (_req, res) => {
    res.json({
      stocks: NIFTY50.map(({ symbol, name, sector }) => ({ symbol, name, sector })),
      indices: INDICES.map(({ symbol, name }) => ({ symbol, name })),
    });
  });

  router.get('/snapshot', (_req, res) => {
    res.json({ ...market.snapshot(), ...market.status() });
  });

  router.get('/quote/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const inst = getInstrument(symbol);
    if (!inst) throw notFound('Unknown symbol');
    res.json({ symbol, name: inst.name, sector: inst.sector, tick: market.getTick(symbol) });
  });

  router.get('/candles/:symbol', validate(candleQuery, 'query'), async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!getInstrument(symbol)) throw notFound('Unknown symbol');
    const candles = await market.getCandles(symbol, req.valid.interval);
    res.json({ symbol, interval: req.valid.interval, simulated: market.provider.isSimulated, candles });
  });

  return router;
}
