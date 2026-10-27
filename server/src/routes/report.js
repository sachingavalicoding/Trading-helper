import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AutoLog, AutoSettings, OptionSettings, ScanIdea } from '../models/index.js';
import { buildDayReport } from '../report/dayReport.js';
import { LADDER } from '../scanner/replay.js';
import { OPTION_LADDER } from '../options/plan.js';
import { summarizeIdeas } from '../scanner/stats.js';
import { effectiveLadder, ladderRows } from '../utils/ladder.js';
import { logger } from '../utils/logger.js';

const query = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/** One text report of a day, for copying into a chat. */
export function reportRoutes({ engine, market, review }) {
  const router = Router();

  router.get('/day', validate(query, 'query'), async (req, res) => {
    const day = req.valid.day ?? engine.marketStatus().istDate;
    const [ideas, eqLog, optLog, autoDoc, optDoc, finished] = await Promise.all([
      ScanIdea.find({ day }).sort({ createdAt: 1 }).lean(),
      AutoLog.find({ user: req.userId, day, segment: { $ne: 'OPT' } }).sort({ decidedAt: 1 }).lean(),
      AutoLog.find({ user: req.userId, day, segment: 'OPT' }).sort({ decidedAt: 1 }).lean(),
      AutoSettings.findOne({ user: req.userId }).lean(),
      OptionSettings.findOne({ user: req.userId }).lean(),
      ScanIdea.find({ status: { $ne: 'OPEN' } }, 'setup side status entry stopLoss exitPrice score createdAt card.entryContext').lean(),
    ]);
    const auto = autoDoc || new AutoSettings({ user: req.userId }).toObject();
    const opt = optDoc || new OptionSettings({ user: req.userId }).toObject();
    const reviewDay = review ? await review.day(req.userId, day).catch((e) => (logger.warn(`report: review failed: ${e.message}`), null)) : null;
    const status = market.status();
    const text = buildDayReport({
      day,
      generatedAt: new Date(),
      market: { provider: status.feed?.provider, simulated: status.feed?.simulated },
      settings: {
        auto: { ...auto, lockLadder: ladderRows(effectiveLadder(auto.lockLadder, LADDER)) },
        options: { ...opt, lockLadder: ladderRows(effectiveLadder(opt.lockLadder, OPTION_LADDER)) },
      },
      ideas,
      eqLog,
      optLog,
      review: reviewDay,
      track: summarizeIdeas(finished.map((i) => ({ ...i, openedAt: i.createdAt, movedPct: i.card?.entryContext?.dayPct ?? null }))),
    });
    res.json({ day, text });
  });

  return router;
}
