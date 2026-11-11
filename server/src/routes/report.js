import { Router } from 'express';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AutoLog, AutoSettings, OptionSettings, Position, ScanIdea } from '../models/index.js';
import { daysCsv, tradesCsv } from '../report/pnlCsv.js';
import { pnlSummary } from '../report/pnlSummary.js';
import { guideText } from '../guide/guide.js';
import { buildDayReport } from '../report/dayReport.js';
import { summarizeIdeas, whatWins } from '../scanner/stats.js';
import { sizeOf } from '../scanner/backtest.js';
import { roundTripCharges } from '../services/charges.js';
import { loadRules } from '../models/TradeDefaults.js';
import { logger } from '../utils/logger.js';
import { lastTradingDayKey } from '../market/marketHours.js';

const query = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const day10 = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pnlQuery = z.object({ from: day10.optional(), to: day10.optional(), segment: z.enum(['all', 'EQ', 'OPT']).default('all'), by: z.enum(['trade', 'day']).default('trade') });

/** Round-trip charges of the trade an idea would make (sized to the Account stop and max amount), in risk units. */
const chargesInR = (riskAmount, maxAmount) => (i) => {
  const qty = sizeOf(i, { riskAmount, maxAmount: maxAmount || 0 });
  const risk = qty * Math.abs(i.entry - i.stopLoss);
  return qty && risk ? roundTripCharges({ qty, price: i.entry }) / risk : null;
};

/** One text report of a day, for copying into a chat. */
export function reportRoutes({ engine, market, review }) {
  const router = Router();

  router.get('/day', validate(query, 'query'), async (req, res) => {
    // Empty day = the last day the market was open (after midnight or before 09:15 that is yesterday, not a day with no trades yet).
    const day = req.valid.day ?? lastTradingDayKey(engine.now(), engine.config?.nseHolidays ?? []);
    const [ideas, eqLog, optLog, autoDoc, optDoc, finished] = await Promise.all([
      ScanIdea.find({ day }).sort({ createdAt: 1 }).lean(),
      AutoLog.find({ user: req.userId, day, segment: { $ne: 'OPT' } }).sort({ decidedAt: 1 }).lean(),
      AutoLog.find({ user: req.userId, day, segment: 'OPT' }).sort({ decidedAt: 1 }).lean(),
      AutoSettings.findOne({ user: req.userId }).lean(),
      OptionSettings.findOne({ user: req.userId }).lean(),
      ScanIdea.find({ status: { $ne: 'OPEN' } }, 'symbol setup side status entry stopLoss exitPrice score createdAt bestR worstR card.checks card.facts').lean(),
    ]);
    const auto = autoDoc || new AutoSettings({ user: req.userId }).toObject();
    const opt = optDoc || new OptionSettings({ user: req.userId }).toObject();
    const reviewDay = review ? await review.day(req.userId, day).catch((e) => (logger.warn(`report: review failed: ${e.message}`), null)) : null;
    const status = market.status();
    const shareRules = await loadRules(req.userId, 'EQ');
    const text = buildDayReport({
      day,
      generatedAt: new Date(),
      market: { provider: status.feed?.provider, simulated: status.feed?.simulated },
      settings: {
        auto,
        options: opt,
        rules: { shares: shareRules, options: await loadRules(req.userId, 'OPT') },
      },
      ideas,
      eqLog,
      optLog,
      review: reviewDay,
      track: summarizeIdeas(finished.map((i) => ({ ...i, openedAt: i.createdAt }))),
      wins: whatWins(finished.map((i) => ({ ...i, openedAt: i.createdAt })), { chargesR: chargesInR(shareRules.stopLoss, auto.maxTradeAmount) }),
    });
    res.json({ day, text });
  });

  /** Profit and loss for the Profit & Loss screen: totals and the same trades grouped by day, week, month, weekday, hour and symbol. */
  router.get('/pnl-summary', validate(pnlQuery.omit({ by: true }), 'query'), async (req, res) => {
    const { from, to, segment } = req.valid;
    const filter = { user: req.userId, status: 'CLOSED' };
    if (segment !== 'all') filter.segment = segment;
    if (from || to) filter.tradingDay = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    res.json(pnlSummary(await Position.find(filter).sort({ closedAt: 1 }).limit(20000).lean()));
  });

  /** The profit and loss as a CSV file: every closed trade (or every day) between two dates. */
  router.get('/pnl.csv', validate(pnlQuery, 'query'), async (req, res) => {
    const { from, to, segment, by } = req.valid;
    const filter = { user: req.userId, status: 'CLOSED' };
    if (segment !== 'all') filter.segment = segment;
    if (from || to) filter.tradingDay = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const positions = await Position.find(filter).sort({ closedAt: 1 }).limit(20000).lean();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="profit-and-loss-${by === 'day' ? 'by-day' : 'trades'}-${from ?? 'start'}-to-${to ?? 'today'}.csv"`);
    res.send(`\uFEFF${by === 'day' ? daysCsv(positions) : tradesCsv(positions)}`);
  });

  /** The how-to-use guide as a Markdown file. */
  // The guide with screenshots, built ahead of time by scripts/build-guide.mjs (pictures taken on demo data).
  const guideFile = (name) => fileURLToPath(new URL(`../guide/${name}`, import.meta.url));
  router.get('/guide.pdf', (_req, res) => {
    res.download(guideFile('app-guide.pdf'), 'nifty-paper-trader-guide.pdf');
  });
  router.get('/guide.html', (_req, res) => {
    res.download(guideFile('app-guide.html'), 'nifty-paper-trader-guide.html');
  });

  router.get('/guide.md', (_req, res) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="app-guide.md"');
    res.send(guideText());
  });

  return router;
}
