import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { INDEX_KEYS } from '../options/symbols.js';
import { MAX_ADD, MAX_DAYS } from '../lab/lab.js';
import { badRequest } from '../utils/errors.js';
import { EXAMPLE_DAYS } from '../lab/examples.js';

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
  segment: z.enum(['options', 'shares']).default('options'),
  edit: z.string().max(4000).optional(),
  // the no-stop test: no stop loss, only a fixed profit lock (lock lockKeep once the profit reaches lockAt) and the emergency floor
  noStop: z.enum(['0', '1']).optional(),
  lockAt: z.coerce.number().min(0).max(10_000_000).optional(),
  lockKeep: z.coerce.number().min(0).max(10_000_000).optional(),
}).refine((q) => !(q.lockAt > 0) || (q.lockKeep ?? 0) < q.lockAt, { message: 'The profit you keep must be less than the profit that starts the lock', path: ['lockKeep'] });

export const SHARES_LAB_NOTE = 'A look back at paper trades on the Nifty 50 stocks over past candles, traded like the live share auto trader: your Account stop sizes each trade (or the combination\'s own risk), the most money per trade, one trade per stock at a time, your most open trades, the daily loss limit, the profit ladder (or a target) and the exit time. No order book and 0.05% slippage each way. A few weeks of trades is a small sample: paper-test before relying on it. Not investment advice.';

const steps = z.array(z.object({ at: z.coerce.number().min(1).max(10_000_000), keep: z.coerce.number().min(1).max(10_000_000) })).max(12);
// order settings to try in place of the saved ones; the same shape is saved by Account > Entries
const editSchema = z.object({
  side: z.enum(['CE', 'PE']).nullish(),
  // options
  stopMode: z.enum(['chart', 'cap', 'atr', 'fixed']).nullish(),
  stopAtr: z.coerce.number().min(0.8).max(2.5).optional(),
  stopPoints: z.coerce.number().min(10).max(150).optional(),
  exits: z.object({ steps: steps.optional(), trail: z.object({ points: z.coerce.number(), start: z.coerce.number().optional() }).nullish(), breakEven: z.coerce.number().min(0).max(150).optional() }).nullish(),
  // shares
  order: z.object({ risk: z.coerce.number().min(0).max(1_000_000).optional(), maxAmount: z.coerce.number().min(0).max(100_000_000).optional(), stopPct: z.coerce.number().min(0).max(10).optional(), target: z.coerce.number().min(0).max(10_000_000).optional(), exitMin: z.coerce.number().min(0).max(24 * 60).optional() }).nullish(),
  steps: steps.nullish(),
});

/** The `edit` query value (JSON) checked, or a 400. */
function editOf(text) {
  if (!text) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badRequest('The order settings could not be read.', 'VALIDATION');
  }
  const parsed = editSchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || 'The order settings are not valid.', 'VALIDATION');
  return parsed.data;
}

export function labRoutes({ lab }) {
  const router = Router();

  router.get('/', validate(query, 'query'), async (req, res) => {
    const q = req.valid;
    const add = (q.add ?? '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, MAX_ADD);
    const edit = editOf(q.edit);
    if (q.segment === 'shares') {
      const choices = await lab.shareChoices(req.userId);
      if (!q.base) return res.json({ choices, note: SHARES_LAB_NOTE });
      return res.json({ choices, note: SHARES_LAB_NOTE, result: await lab.runShares(req.userId, { base: q.base, add, from: q.from, to: q.to, days: q.days, edit }) });
    }
    const choices = await lab.choices(req.userId, q.index);
    if (!q.base) return res.json({ choices, note: LAB_NOTE });
    res.json({ choices, note: LAB_NOTE, result: await lab.run(req.userId, { base: q.base, add, from: q.from, to: q.to, days: q.days, index: q.index, prices: q.prices, noStop: q.noStop === '1' ? { at: q.lockAt ?? 0, keep: q.lockKeep ?? 0 } : null, edit }) });
  });

  // "where would this have bought?": one check (or a combination) on the last few days of the Nifty chart, for the info button
  const exampleQuery = z.object({ keys: z.string().min(2).max(400), need: z.coerce.number().int().min(1).max(20).optional(), window: z.coerce.number().int().min(1).max(6).optional(), days: z.coerce.number().int().refine((d) => EXAMPLE_DAYS.includes(d)).default(5) });
  router.get('/examples', validate(exampleQuery, 'query'), async (req, res) => {
    const keys = req.valid.keys.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 20);
    res.json(await lab.examples({ keys, need: req.valid.need, window: req.valid.window, days: req.valid.days }));
  });

  // one stock's 5-minute bars around one day, for the chart of a shares Lab entry
  router.get('/bars', validate(z.object({ symbol: z.string().regex(/^[A-Z0-9&-]{1,30}$/), day }), 'query'), (req, res) => {
    res.json({ bars: lab.shareBars(req.valid.symbol, req.valid.day) });
  });

  return router;
}
