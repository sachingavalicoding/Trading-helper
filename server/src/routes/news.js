import { Router } from 'express';
import { z } from 'zod';
import { NIFTY50 } from '../market/instruments.js';
import { validate } from '../middleware/validate.js';
import { MARKET } from '../news/service.js';

export const NEWS_DISCLAIMER = 'Headlines are tagged by simple keyword rules, so a tag can be wrong. Read the headline. Not investment advice.';
const symbols = new Set([MARKET, ...NIFTY50.map((s) => s.symbol)]);
const query = z.object({ symbol: z.string().transform((s) => s.toUpperCase()).refine((s) => symbols.has(s), 'Unknown symbol').default(MARKET) });

const feedQuery = z.object({
  hours: z.coerce.number().int().min(1).max(72).default(48),
  limit: z.coerce.number().int().min(1).max(300).default(150),
  symbol: z.string().transform((s) => s.toUpperCase()).refine((s) => symbols.has(s), 'Unknown symbol').optional(),
  label: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']).optional(),
});

export function newsRoutes({ news }) {
  const router = Router();

  // Badges for lists: one line per Nifty 50 stock that has fresh, non-neutral news.
  router.get('/summary', async (_req, res) => {
    res.json({ signals: await news.signals(), updatedAt: news.lastRefresh, disclaimer: NEWS_DISCLAIMER });
  });

  // Everything in one list, for the News tab: the market and all Nifty 50 stocks.
  router.get('/feed', validate(feedQuery, 'query'), async (req, res) => {
    res.json({ items: await news.feed(req.valid), updatedAt: news.lastRefresh, disclaimer: NEWS_DISCLAIMER });
  });

  // Headlines for one stock (or the whole market when no symbol is given).
  router.get('/', validate(query, 'query'), async (req, res) => {
    const symbol = req.valid.symbol;
    res.json({ symbol, items: await news.forSymbol(symbol), updatedAt: news.lastRefresh, disclaimer: NEWS_DISCLAIMER });
  });

  return router;
}
