import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AutoLog, AutoSettings, ScanIdea } from '../models/index.js';
import { summarizeLog } from '../auto/logSummary.js';
import { loadRules } from '../models/TradeDefaults.js';
import { comboInput, normalizeCombos } from '../combos/combos.js';
import { shareRulesOf } from '../scanner/entryRules.js';

// The setups the scanner can raise today (Level retest and VWAP pullback are switched off for good in scanner/service.js).
export const SHARE_SETUPS = ['Opening range breakout', 'Gap and go', 'News gap', 'Trend score'];

export const AUTO_DISCLAIMER = 'Auto trading places virtual (paper) orders only. It follows the scanner\'s rules and does not guarantee profit. Not investment advice.';

const patch = z
  .object({
    enabled: z.boolean(),
    earlyNews: z.boolean(),
    trendScore: z.boolean(),
    minScore: z.coerce.number().min(60).max(100),
    maxOpen: z.coerce.number().int().min(1).max(100),
    maxTrades: z.coerce.number().int().min(0).max(10000), // 0 = no limit
    entryFrom: z.coerce.number().int().min(555).max(914),
    entryTo: z.coerce.number().int().min(556).max(915),
    riskPct: z.coerce.number().min(0.1).max(3),
    dailyLossPct: z.coerce.number().min(0.5).max(100),
    maxShares: z.coerce.number().int().min(0).max(100000),
    maxTradeAmount: z.coerce.number().min(1000).max(100_000_000),
    skipSetups: z.array(z.enum(SHARE_SETUPS)).max(SHARE_SETUPS.length),
    combos: comboInput,
    shareRules: z
      .object({
        marketAgree: z.boolean(),
        minVsNifty: z.coerce.number().min(0).max(5),
        minRelVol: z.coerce.number().min(0).max(10),
        confirmBar: z.boolean(),
        noChaseR: z.coerce.number().min(0.1).max(2),
        minStopPct: z.coerce.number().min(0).max(2),
        stopAfterLosses: z.coerce.number().int().min(0).max(20),
        target: z.coerce.number().min(0).max(100000),
      })
      .partial(),
  })
  .partial();

export function autoRoutes({ autoTrader }) {
  const dayOf = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const router = Router();
  const view = async (userId, doc) => {
    const s = doc || new AutoSettings({ user: userId });
    return {
      settings: { enabled: s.enabled, minScore: s.minScore, maxOpen: s.maxOpen, maxTrades: s.maxTrades ?? 0, entryFrom: s.entryFrom ?? 555, entryTo: s.entryTo ?? 915, riskPct: s.riskPct, dailyLossPct: s.dailyLossPct, maxShares: s.maxShares, maxTradeAmount: s.maxTradeAmount, earlyNews: s.earlyNews !== false, trendScore: s.trendScore === true, skipSetups: [...(s.skipSetups ?? [])], shareRules: shareRulesOf(s.shareRules), combos: normalizeCombos(s.combos ?? []) },
      setupChoices: SHARE_SETUPS,
      rules: await loadRules(userId, 'EQ'),
      today: await autoTrader.todaySummary(userId),
      disclaimer: AUTO_DISCLAIMER,
    };
  };

  router.get('/', async (req, res) => {
    res.json(await view(req.userId, await AutoSettings.findOne({ user: req.userId })));
  });

  router.put('/', validate(patch), async (req, res) => {
    if (req.body.entryFrom !== undefined || req.body.entryTo !== undefined) {
      const cur = await AutoSettings.findOne({ user: req.userId }).lean();
      const from = req.body.entryFrom ?? cur?.entryFrom ?? 555;
      const to = req.body.entryTo ?? cur?.entryTo ?? 915;
      if (!(from < to)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'The last time for a new trade must be after the first' } });
    }
    const { shareRules, ...rest } = req.body;
    const body = rest.combos ? { ...rest, combos: normalizeCombos(rest.combos) } : { ...rest };
    // each rule is saved on its own, so turning one on from the study leaves the others as they are
    for (const [k, v] of Object.entries(shareRules ?? {})) body[`shareRules.${k}`] = v;
    const doc = await AutoSettings.findOneAndUpdate({ user: req.userId }, { $set: body, $setOnInsert: { user: req.userId } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    res.json(await view(req.userId, doc));
  });

  // The day's auto log: every decision with its numbers, plus a summary to review in the evening.
  router.get('/log', async (req, res) => {
    const parsed = dayOf.safeParse(req.query.day ?? autoTrader.engine.marketStatus().istDate);
    if (!parsed.success) return res.status(400).json({ error: { message: 'day must look like 2026-10-26' } });
    const day = parsed.data;
    const entries = await AutoLog.find({ user: req.userId, day, segment: { $ne: 'OPT' } }).sort({ decidedAt: 1 }).lean();
    const ids = entries.map((e) => e.idea).filter(Boolean);
    const ideas = new Map((ids.length ? await ScanIdea.find({ _id: { $in: ids } }, 'status').lean() : []).map((i) => [String(i._id), i]));
    res.json({ day, summary: summarizeLog(entries, ideas), entries: entries.map(({ card, ...e }) => ({ ...e, checks: card?.checks })) });
  });

  return router;
}
