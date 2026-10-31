import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { NIFTY50 } from '../market/instruments.js';
import { INDEXES, INDEX_KEYS } from '../options/symbols.js';
import { notFound } from '../utils/errors.js';

export const REVIEW_DISCLAIMER = 'A look back at rule-based calls against what the price did. A few days of results are noise, not proof. Not investment advice.';

const dayQuery = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must look like 2026-10-26').optional() });
const techQuery = z.object({ days: z.coerce.number().int().min(5).max(60).default(30) });
/** `<comboId>` or `<comboId>:<key>,<key>`: the combination to improve and the checks to add to it. */
const parseTrial = (v) => {
  if (!v) return null;
  const [id, add = ''] = v.split(':');
  return id ? { id, add: add.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 5) } : null;
};
const patternsQuery = dayQuery.extend({ index: z.enum(INDEX_KEYS).default('NIFTY'), checks: z.string().max(1500).optional(), trial: z.string().max(400).optional(), real: z.enum(['0', '1']).default('1') }); // checks: comma-separated indicator keys to draw
const known = new Set([...INDEX_KEYS.map((k) => INDEXES[k].symbol), ...NIFTY50.map((s) => s.symbol)]);

export function reviewRoutes({ review }) {
  const router = Router();

  // Every stock that had a morning news call or a scanner idea that day, against how it traded.
  router.get('/day', validate(dayQuery, 'query'), async (req, res) => {
    const day = req.valid.day ?? review.today;
    res.json({ ...(await review.day(req.userId, day)), disclaimer: REVIEW_DISCLAIMER });
  });

  // One stock on one day with its chart, news and trades.
  router.get('/stock/:symbol', validate(dayQuery, 'query'), async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!known.has(symbol)) throw notFound('Unknown symbol');
    res.json({ ...(await review.stock(req.userId, symbol, req.valid.day ?? review.today)), disclaimer: REVIEW_DISCLAIMER });
  });

  // The Nifty (or Sensex, ?index=SENSEX) chart of one day with every pattern and combination that formed on it and what a one-lot option buy at each would have done.
  router.get('/patterns', validate(patternsQuery, 'query'), async (req, res) => {
    const day = req.valid.day ?? review.today;
    res.json({ ...(await review.patterns(req.userId, day, req.valid.index, (req.valid.checks ?? '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 40), { trial: parseTrial(req.valid.trial), real: req.valid.real === '1' })), disclaimer: REVIEW_DISCLAIMER });
  });

  // Which techniques, checks and kinds of news paid.
  router.get('/techniques', validate(techQuery, 'query'), async (req, res) => {
    res.json({ ...(await review.techniques(req.userId, req.valid.days)), disclaimer: REVIEW_DISCLAIMER });
  });

  return router;
}
