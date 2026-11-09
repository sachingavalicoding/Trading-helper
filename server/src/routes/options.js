import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AutoLog, OptionSettings } from '../models/index.js';
import { summarizeLog } from '../auto/logSummary.js';
import { INDEXES, INDEX_KEYS, DEFAULT_INDEX, optionLabel } from '../options/symbols.js';
import { LIVE_PATTERNS, DEFAULT_PATTERNS, activeIndexes } from '../options/optionTrader.js';
import { loadRules } from '../models/TradeDefaults.js';
import { badRequest } from '../utils/errors.js';
import { comboInput, normalizeCombos } from '../combos/combos.js';
import { MOVED_KEYS, movedOf, movedWords } from '../options/moved.js';
import { forIndex } from '../options/indexSettings.js';
import { OPTION_SCORE_PARTS } from '../options/signal.js';
import { marketMood, todayVerdict, istMinutesNow } from '../options/todayCheck.js';
import { istParts } from '../market/marketHours.js';

export const OPTIONS_DISCLAIMER = 'Options are paper (virtual) trades only. About 9 in 10 individual traders lose money in index options, so treat results here as a test, not a promise. Not investment advice.';

const patch = z
  .object({
    enabled: z.boolean(),
    maxLots: z.coerce.number().int().min(1).max(20),
    maxOpen: z.coerce.number().int().min(1).max(3),
    maxTrades: z.coerce.number().int().min(1).max(10),
    budget: z.coerce.number().min(5000).max(100_000_000),
    dailyLossPct: z.coerce.number().min(2).max(30),
    lossStreak: z.coerce.number().int().min(0).max(5),
    benchAfter: z.coerce.number().int().min(0).max(10),
    scoreEntries: z.boolean(),
    minScore: z.coerce.number().int().min(60).max(100),
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
    comboEntries: z.boolean(),
    entryClock: z.enum(['5m', '1m', '1s']),
    exitClock: z.enum(['5m', '1m', '1s']),
    secondConfirm: z.coerce.number().int().min(0).max(15),
    trailMode: z.enum(['off', 'points']),
    trailPoints: z.coerce.number().min(5).max(200),
    trailStart: z.coerce.number().min(0).max(200),
    breakEvenPoints: z.coerce.number().min(0).max(200),
    chasePct: z.coerce.number().min(0).max(200),
    chaseMinutes: z.coerce.number().int().min(5).max(60),
    movedCheck: z.enum(['off', ...MOVED_KEYS]),
    movedLimit: z.coerce.number().min(0).max(100),
    withDay: z.boolean(),
    comboStreak: z.coerce.number().int().min(0).max(5),
    probation: z.boolean(),
    pauseToday: z.boolean(), // true: no new automatic buy for the rest of today; false: buy again
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
    const entries = { scoreEntries: s.scoreEntries === true, minScore: s.minScore ?? 70, scoreChecks: OPTION_SCORE_PARTS, patternEntries: s.patternEntries !== false, patternMinScore: s.patternMinScore ?? 0, comboMinScore: s.comboMinScore ?? 0, indexes: activeIndexes(s), mirror: s.mirror === true, patterns: [...(s.patterns ?? DEFAULT_PATTERNS)], combos: normalizeCombos(s.combos ?? []), patternStopMode: s.patternStopMode ?? 'chart', patternStopAtr: s.patternStopAtr ?? 2, patternStopPoints: s.patternStopPoints ?? 30, comboEntries: s.comboEntries !== false, entryClock: s.entryClock ?? '5m', exitClock: s.exitClock ?? '1m', secondConfirm: s.secondConfirm ?? 3, trailMode: s.trailMode ?? 'off', trailPoints: s.trailPoints ?? 25, trailStart: s.trailStart ?? 25, breakEvenPoints: s.breakEvenPoints ?? 0, chasePct: s.chasePct ?? 0, chaseMinutes: s.chaseMinutes ?? 15, movedCheck: s.movedCheck ?? 'off', movedLimit: s.movedLimit ?? 0, movedText: movedOf(s) ? movedWords(movedOf(s)) : null, withDay: s.withDay === true, comboStreak: s.comboStreak ?? 0, probation: s.probation !== false, pausedToday: Boolean(s.pausedOn) && s.pausedOn === optionTrader.engine.marketStatus().istDate, entryFrom: s.entryFrom ?? 555, entryTo: s.entryTo ?? 915 };
    return { settings: { enabled, maxLots, maxOpen, maxTrades, budget, dailyLossPct, lossStreak: s.lossStreak ?? 2, benchAfter: s.benchAfter ?? 3, ...entries }, indexChoices: INDEX_KEYS.map((k) => ({ key: k, name: INDEXES[k].name, short: INDEXES[k].short })), patternChoices: LIVE_PATTERNS, rules: await loadRules(userId, 'OPT'), today: await optionTrader.todaySummary(userId), disclaimer: OPTIONS_DISCLAIMER };
  };

  router.get('/', async (req, res) => {
    res.json(await view(req.userId, await OptionSettings.findOne({ user: req.userId })));
  });

  router.put('/', validate(patch), async (req, res) => {
    if (req.body.entryFrom !== undefined || req.body.entryTo !== undefined) {
      const cur = await OptionSettings.findOne({ user: req.userId }).lean();
      const from = req.body.entryFrom ?? cur?.entryFrom ?? 555;
      const to = req.body.entryTo ?? cur?.entryTo ?? 915;
      if (!(from + 15 <= to)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'The last time for a new trade must be at least 15 minutes after the first' } });
    }
    const { pauseToday, ...rest } = req.body;
    const body = rest.combos ? { ...rest, combos: normalizeCombos(rest.combos) } : { ...rest };
    if (pauseToday !== undefined) body.pausedOn = pauseToday ? optionTrader.engine.marketStatus().istDate : null;
    const doc = await OptionSettings.findOneAndUpdate({ user: req.userId }, { $set: body, $setOnInsert: { user: req.userId } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    res.json(await view(req.userId, doc));
  });

  // The chart read of one index  for both sides, and the at-the-money contracts the trader would buy.
  router.get('/read', async (req, res) => {
    const parsed = indexQuery.safeParse(req.query.index ?? undefined);
    if (!parsed.success) return res.status(400).json({ error: { message: 'index must be NIFTY' } });
    const index = parsed.data;
    const read = await optionTrader.read(index);
    if (!read.ready) return res.json({ ready: false });
    const [ce, pe] = await Promise.all(['CE', 'PE'].map((type) => optionTrader.market.pickOption({ type, now: optionTrader.now(), index }).catch(() => null)));
    const quote = (c) => c && { symbol: c.symbol, label: optionLabel(c.symbol), strike: c.strike, expiry: c.expiry, lotSize: c.lotSize, ltp: c.ltp, lotCost: c.ltp ? Math.round(c.ltp * c.lotSize) : null };
    const preview = await optionTrader.preview(req.userId, read, { CE: ce, PE: pe });
    res.json({ ready: true, preview, index, underlying: INDEXES[index].symbol, spot: read.spot, atr5: read.atr5, snapshot: read.snapshot, best: read.best?.type ?? null, ce: slim(read.ce), pe: slim(read.pe), contracts: { CE: quote(ce), PE: quote(pe) }, at: new Date().toISOString() });
  });

  // Buy one now by hand, with the stop and profit lock from the Account tab.
  // "Is it a good time to trade?": the index today (trend or chop) and your own state (losses, losses in a row, trades left), as one verdict.
  router.get('/today-check', async (req, res) => {
    const parsed = indexQuery.safeParse(req.query.index ?? undefined);
    if (!parsed.success) return res.status(400).json({ error: { message: 'index must be NIFTY' } });
    const index = parsed.data;
    const symbol = INDEXES[index].symbol;
    const now = optionTrader.now();
    const day = optionTrader.engine.marketStatus().istDate;
    const [c1, daily, raw, today, lossesInARow] = await Promise.all([
      optionTrader.market.getCandles(symbol, '1m').catch(() => []),
      optionTrader.market.getDaily(symbol).catch(() => []),
      OptionSettings.findOne({ user: req.userId }).lean(),
      optionTrader.todaySummary(req.userId),
      optionTrader.lossesInARowToday(req.userId),
    ]);
    const s = forIndex(raw || new OptionSettings({ user: req.userId }).toObject(), index);
    const mood = marketMood(c1.filter((c) => istParts(new Date(c.time * 1000)).dateKey === day), daily);
    const me = {
      pnl: today.pnl,
      trades: today.trades,
      maxTrades: s.maxTrades ?? 3,
      dailyLoss: ((s.budget ?? 60000) * (s.dailyLossPct ?? 10)) / 100,
      lossesInARow,
      lossStreak: s.lossStreak ?? 2,
      paused: Boolean(s.pausedOn) && s.pausedOn === day,
      open: today.open,
      capLoss: true,
      benched: normalizeCombos(s.combos ?? []).filter((c) => c.benchedOn).map((c) => c.name),
    };
    res.json({ index, day, mood, me, ...todayVerdict(mood, me, { minutes: istMinutesNow(now) }), at: now.toISOString() });
  });

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
