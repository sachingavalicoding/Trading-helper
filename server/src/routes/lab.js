import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { INDEX_KEYS } from '../options/symbols.js';
import { MAX_ADD, MAX_DAYS } from '../lab/lab.js';

export const LAB_NOTE = 'A look back at paper trades of one lot on past candles, traded like the options study (one at a time, at most 3 a day, your Account stop and profit ladder). Days with saved real option prices use them; the other days are estimated. A few weeks of trades is a small sample and some indicators will look good by luck: paper-test before relying on one. Not investment advice.';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({
  base: z.string().min(3).max(120).optional(),
  add: z.string().max(400).optional(),
  from: day.optional(),
  to: day.optional(),
  days: z.coerce.number().int().min(3).max(MAX_DAYS).default(22),
  index: z.enum(INDEX_KEYS).default('NIFTY'),
  prices: z.enum(['mixed', 'real', 'estimated']).default('mixed'),
});

export function labRoutes({ lab }) {
  const router = Router();

  router.get('/', validate(query, 'query'), async (req, res) => {
    const q = req.valid;
    const choices = await lab.choices(req.userId, q.index);
    if (!q.base) return res.json({ choices, note: LAB_NOTE });
    const add = (q.add ?? '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, MAX_ADD);
    res.json({ choices, note: LAB_NOTE, result: await lab.run(req.userId, { base: q.base, add, from: q.from, to: q.to, days: q.days, index: q.index, prices: q.prices }) });
  });

  // The best stop and profit ladder for the start (with any picked checks): the study's research on the same days. Slower, so it is asked for on its own.
  router.get('/exits', validate(query, 'query'), async (req, res) => {
    const q = req.valid;
    if (!q.base) return res.status(400).json({ error: { code: 'VALIDATION', message: 'base is required' } });
    const add = (q.add ?? '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, MAX_ADD);
    res.json({ research: await lab.exits(req.userId, { base: q.base, add, from: q.from, to: q.to, days: q.days, index: q.index, prices: q.prices }), note: LAB_NOTE });
  });

  return router;
}
