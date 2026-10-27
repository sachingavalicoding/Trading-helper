import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AutoLog, OptionSettings } from '../models/index.js';
import { summarizeLog } from '../auto/logSummary.js';
import { UNDERLYING, optionLabel } from '../options/symbols.js';
import { OPTION_WEIGHTS } from '../options/signal.js';
import { badRequest } from '../utils/errors.js';

export const OPTIONS_DISCLAIMER = 'Options are paper (virtual) trades only. About 9 in 10 individual traders lose money in index options, so treat results here as a test, not a promise. Not investment advice.';

const patch = z
  .object({
    enabled: z.boolean(),
    minScore: z.coerce.number().min(60).max(100),
    maxLots: z.coerce.number().int().min(1).max(20),
    maxOpen: z.coerce.number().int().min(1).max(3),
    maxTrades: z.coerce.number().int().min(1).max(10),
    budget: z.coerce.number().min(5000).max(100_000_000),
    maxLossPct: z.coerce.number().min(1).max(20),
    dailyLossPct: z.coerce.number().min(2).max(30),
    trailPct: z.coerce.number().min(0).max(60),
    lockAtAmount: z.coerce.number().min(100).max(1_000_000),
    lockKeepAmount: z.coerce.number().min(0).max(1_000_000),
  })
  .partial()
  .refine((d) => d.lockAtAmount == null || d.lockKeepAmount == null || d.lockAtAmount > d.lockKeepAmount, { message: 'The profit that starts the lock must be larger than the profit it keeps', path: ['lockKeepAmount'] });

const buySchema = z.object({ type: z.enum(['CE', 'PE']), lots: z.coerce.number().int().min(1).max(20).default(1) });
const dayOf = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// What a screen needs from a chart read: the scores and reasons, not the raw indicator arrays.
const slim = (side) => side && { type: side.type, score: side.score, checks: side.checks, gates: side.gates, blocked: side.blocked, trigger: side.trigger, stop: side.stop, levels: side.levels.slice(0, 3) };

export function optionRoutes({ optionTrader }) {
  const router = Router();
  const view = async (userId, doc) => {
    const s = doc || new OptionSettings({ user: userId });
    const { enabled, minScore, maxLots, maxOpen, maxTrades, budget, maxLossPct, dailyLossPct, trailPct, lockAtAmount, lockKeepAmount } = s;
    return { settings: { enabled, minScore, maxLots, maxOpen, maxTrades, budget, maxLossPct, dailyLossPct, trailPct, lockAtAmount, lockKeepAmount }, today: await optionTrader.todaySummary(userId), weights: OPTION_WEIGHTS, disclaimer: OPTIONS_DISCLAIMER };
  };

  router.get('/', async (req, res) => {
    res.json(await view(req.userId, await OptionSettings.findOne({ user: req.userId })));
  });

  router.put('/', validate(patch), async (req, res) => {
    const doc = await OptionSettings.findOneAndUpdate({ user: req.userId }, { $set: req.body, $setOnInsert: { user: req.userId } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    res.json(await view(req.userId, doc));
  });

  // The Nifty chart read for both sides, and the at-the-money contracts the trader would buy.
  router.get('/read', async (_req, res) => {
    const read = await optionTrader.read();
    if (!read.ready) return res.json({ ready: false });
    const [ce, pe] = await Promise.all(['CE', 'PE'].map((type) => optionTrader.market.pickOption({ type, now: optionTrader.now() }).catch(() => null)));
    const quote = (c) => c && { symbol: c.symbol, label: optionLabel(c.symbol), strike: c.strike, expiry: c.expiry, lotSize: c.lotSize, ltp: c.ltp, lotCost: c.ltp ? Math.round(c.ltp * c.lotSize) : null };
    res.json({ ready: true, underlying: UNDERLYING, spot: read.spot, atr5: read.atr5, snapshot: read.snapshot, best: read.best?.type ?? null, ce: slim(read.ce), pe: slim(read.pe), contracts: { CE: quote(ce), PE: quote(pe) }, at: new Date().toISOString() });
  });

  // Buy one now by hand, with the chart's stop, the target ladder and the lock.
  router.post('/buy', validate(buySchema), async (req, res) => {
    const r = await optionTrader.enterManually(req.userId, req.body.type, req.body.lots);
    if (r.skipped) throw badRequest(`Not bought: ${r.skipped}`, 'NOT_BOUGHT');
    res.status(201).json({ order: r.order, plan: r.plan });
  });

  router.get('/log', async (req, res) => {
    const parsed = dayOf.safeParse(req.query.day ?? optionTrader.engine.marketStatus().istDate);
    if (!parsed.success) return res.status(400).json({ error: { message: 'day must look like 2026-10-26' } });
    const day = parsed.data;
    const entries = await AutoLog.find({ user: req.userId, day, segment: 'OPT' }).sort({ decidedAt: 1 }).lean();
    res.json({ day, summary: summarizeLog(entries), entries: entries.map(({ card, ...e }) => ({ ...e, checks: card?.checks, label: optionLabel(e.symbol) })) });
  });

  return router;
}
