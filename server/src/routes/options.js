import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AutoLog, OptionSettings } from '../models/index.js';
import { summarizeLog } from '../auto/logSummary.js';
import { INDEXES, INDEX_KEYS, DEFAULT_INDEX, optionLabel } from '../options/symbols.js';
import { LIVE_PATTERNS, DEFAULT_PATTERNS, activeIndexes } from '../options/optionTrader.js';
import { loadRules } from '../models/TradeDefaults.js';
import { badRequest } from '../utils/errors.js';
import { SENSEX_KEYS } from '../options/indexSettings.js';
import { comboInput, normalizeCombos } from '../combos/combos.js';

export const OPTIONS_DISCLAIMER = 'Options are paper (virtual) trades only. About 9 in 10 individual traders lose money in index options, so treat results here as a test, not a promise. Not investment advice.';

const patch = z
  .object({
    enabled: z.boolean(),
    maxLots: z.coerce.number().int().min(1).max(20),
    maxOpen: z.coerce.number().int().min(1).max(3),
    maxTrades: z.coerce.number().int().min(1).max(10),
    budget: z.coerce.number().min(5000).max(100_000_000),
    dailyLossPct: z.coerce.number().min(2).max(30),
    patternEntries: z.boolean(),
    patternMinScore: z.coerce.number().min(0).max(95),
    comboMinScore: z.coerce.number().min(0).max(95),
    indexes: z.array(z.enum(INDEX_KEYS)).min(1),
    mirror: z.boolean(),
    patternStopMode: z.enum(['chart', 'cap', 'atr', 'fixed']),
    patternStopAtr: z.coerce.number().min(0.8).max(2.5),
    patternStopPoints: z.coerce.number().min(10).max(150),
    entryFrom: z.coerce.number().int().min(555).max(914),
    entryTo: z.coerce.number().int().min(556).max(915),
    sensexOwn: z.boolean(),
    sensexStopMode: z.enum(['chart', 'cap', 'atr', 'fixed']),
    sensexStopAtr: z.coerce.number().min(0.8).max(2.5),
    sensexStopPoints: z.coerce.number().min(20).max(600),
    sensexTrailMode: z.enum(['off', 'points']).nullable(),
    sensexTrailPoints: z.coerce.number().min(5).max(1000).nullable(),
    sensexTrailStart: z.coerce.number().min(0).max(1000).nullable(),
    sensexBreakEven: z.coerce.number().min(0).max(1000).nullable(),
    sensexEntryFrom: z.coerce.number().int().min(555).max(914).nullable(),
    sensexEntryTo: z.coerce.number().int().min(556).max(915).nullable(),
    sensexMaxLots: z.coerce.number().int().min(1).max(20).nullable(),
    sensexPatterns: z.array(z.enum(LIVE_PATTERNS.map((p) => p.key))).max(LIVE_PATTERNS.length).nullable(),
    sensexSide: z.enum(['both', 'CE', 'PE']).nullable(),
    comboEntries: z.boolean(),
    trailMode: z.enum(['off', 'points']),
    trailPoints: z.coerce.number().min(5).max(200),
    trailStart: z.coerce.number().min(0).max(200),
    breakEvenPoints: z.coerce.number().min(0).max(200),
    patterns: z.array(z.enum(LIVE_PATTERNS.map((p) => p.key))).max(LIVE_PATTERNS.length),
    combos: comboInput,
  })
  .partial();

const buySchema = z.object({ type: z.enum(['CE', 'PE']), lots: z.coerce.number().int().min(1).max(20).default(1), index: z.enum(INDEX_KEYS).default(DEFAULT_INDEX) });
const indexQuery = z.enum(INDEX_KEYS).default(DEFAULT_INDEX);
const dayOf = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// What a screen needs from a chart read: the scores and reasons, not the raw indicator arrays.
const slim = (side) => side && { type: side.type, score: side.score, checks: side.checks, gates: side.gates, blocked: side.blocked, trigger: side.trigger, stop: side.stop, levels: side.levels.slice(0, 3) };

export function optionRoutes({ optionTrader }) {
  const router = Router();
  const view = async (userId, doc) => {
    const s = doc || new OptionSettings({ user: userId });
    const { enabled, maxLots, maxOpen, maxTrades, budget, dailyLossPct } = s;
    const entries = { patternEntries: s.patternEntries !== false, patternMinScore: s.patternMinScore ?? 0, comboMinScore: s.comboMinScore ?? 0, indexes: activeIndexes(s), mirror: s.mirror === true, patterns: [...(s.patterns ?? DEFAULT_PATTERNS)], combos: normalizeCombos(s.combos ?? []), patternStopMode: s.patternStopMode ?? 'chart', patternStopAtr: s.patternStopAtr ?? 2, patternStopPoints: s.patternStopPoints ?? 30, comboEntries: s.comboEntries !== false, trailMode: s.trailMode ?? 'off', trailPoints: s.trailPoints ?? 25, trailStart: s.trailStart ?? 25, breakEvenPoints: s.breakEvenPoints ?? 0, entryFrom: s.entryFrom ?? 555, entryTo: s.entryTo ?? 915, sensexOwn: s.sensexOwn === true, sensexStopMode: s.sensexStopMode ?? 'chart', sensexStopAtr: s.sensexStopAtr ?? 2, sensexStopPoints: s.sensexStopPoints ?? 100, ...Object.fromEntries(SENSEX_KEYS.map((k) => [k, s[k] ?? null])) };
    return { settings: { enabled, maxLots, maxOpen, maxTrades, budget, dailyLossPct, ...entries }, indexChoices: INDEX_KEYS.map((k) => ({ key: k, name: INDEXES[k].name, short: INDEXES[k].short })), patternChoices: LIVE_PATTERNS, rules: await loadRules(userId, 'OPT'), sensexRules: await loadRules(userId, 'OPT', { index: 'SENSEX' }), today: await optionTrader.todaySummary(userId), disclaimer: OPTIONS_DISCLAIMER };
  };

  router.get('/', async (req, res) => {
    res.json(await view(req.userId, await OptionSettings.findOne({ user: req.userId })));
  });

  router.put('/', validate(patch), async (req, res) => {
    if (req.body.sensexEntryFrom != null || req.body.sensexEntryTo != null) {
      const cur = await OptionSettings.findOne({ user: req.userId }).lean();
      const from = req.body.sensexEntryFrom ?? cur?.sensexEntryFrom ?? cur?.entryFrom ?? 555;
      const to = req.body.sensexEntryTo ?? cur?.sensexEntryTo ?? cur?.entryTo ?? 915;
      if (!(from + 15 <= to)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'For the Sensex, the last time for a new trade must be at least 15 minutes after the first' } });
    }
    if (req.body.entryFrom !== undefined || req.body.entryTo !== undefined) {
      const cur = await OptionSettings.findOne({ user: req.userId }).lean();
      const from = req.body.entryFrom ?? cur?.entryFrom ?? 555;
      const to = req.body.entryTo ?? cur?.entryTo ?? 915;
      if (!(from + 15 <= to)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'The last time for a new trade must be at least 15 minutes after the first' } });
    }
    const body = req.body.combos ? { ...req.body, combos: normalizeCombos(req.body.combos) } : req.body;
    const doc = await OptionSettings.findOneAndUpdate({ user: req.userId }, { $set: body, $setOnInsert: { user: req.userId } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    res.json(await view(req.userId, doc));
  });

  // The chart read of one index (?index=NIFTY|SENSEX) for both sides, and the at-the-money contracts the trader would buy.
  router.get('/read', async (req, res) => {
    const parsed = indexQuery.safeParse(req.query.index ?? undefined);
    if (!parsed.success) return res.status(400).json({ error: { message: 'index must be NIFTY or SENSEX' } });
    const index = parsed.data;
    const read = await optionTrader.read(index);
    if (!read.ready) return res.json({ ready: false });
    const [ce, pe] = await Promise.all(['CE', 'PE'].map((type) => optionTrader.market.pickOption({ type, now: optionTrader.now(), index }).catch(() => null)));
    const quote = (c) => c && { symbol: c.symbol, label: optionLabel(c.symbol), strike: c.strike, expiry: c.expiry, lotSize: c.lotSize, ltp: c.ltp, lotCost: c.ltp ? Math.round(c.ltp * c.lotSize) : null };
    const preview = await optionTrader.preview(req.userId, read, { CE: ce, PE: pe });
    res.json({ ready: true, preview, index, underlying: INDEXES[index].symbol, spot: read.spot, atr5: read.atr5, snapshot: read.snapshot, best: read.best?.type ?? null, ce: slim(read.ce), pe: slim(read.pe), contracts: { CE: quote(ce), PE: quote(pe) }, at: new Date().toISOString() });
  });

  // Buy one now by hand, with the stop and profit lock from the Account tab.
  router.post('/buy', validate(buySchema), async (req, res) => {
    const r = await optionTrader.enterManually(req.userId, req.body.type, req.body.lots, req.body.index);
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
