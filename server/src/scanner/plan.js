import { NIFTY50 } from '../market/instruments.js';
import { istDay } from './context.js';

const MAX_ITEMS = 8;
const GAP_PCT = 0.7;
const round2 = (n) => Math.round(n * 100) / 100;

/** High, low and close of the latest session before today, from 1-minute candles. */
function priorSession(c1, today) {
  const prior = c1.filter((b) => istDay(b.time) < today);
  if (!prior.length) return null;
  const day = istDay(prior.at(-1).time);
  const bars = prior.filter((b) => istDay(b.time) === day);
  return { high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)), close: bars.at(-1).close };
}

/**
 * The pre-market plan: which Nifty 50 stocks deserve attention today and at what price the
 * idea starts. It leans on three simple things: fresh news (24 hours), where yesterday closed in
 * its range, and a gap at the open. It never says "buy now", it names the level to wait for.
 */
export function buildPlan({ store, market, signals = {}, now = new Date() }) {
  const today = istDay(now.getTime() / 1000);
  const items = [];
  for (const { symbol, name } of NIFTY50) {
    const c1 = store.get(symbol);
    const tick = market.getTick(symbol);
    const prior = c1 && priorSession(c1, today);
    if (!prior) continue;
    const why = [];
    let score = 0;

    const news = signals[symbol] ?? null;
    if (news) {
      const pts = Math.max(-3, Math.min(3, news.net));
      score += pts;
      why.push(`${news.label === 'BULLISH' ? 'Good' : 'Bad'} news: ${news.title}`);
    }

    const range = prior.high - prior.low;
    const pos = range > 0 ? (prior.close - prior.low) / range : 0.5;
    if (pos >= 0.75) {
      score += 1;
      why.push('Closed near the high yesterday');
    } else if (pos <= 0.25) {
      score -= 1;
      why.push('Closed near the low yesterday');
    }

    const gapPct = tick?.open && tick.prevClose ? ((tick.open - tick.prevClose) / tick.prevClose) * 100 : 0;
    if (Math.abs(gapPct) >= GAP_PCT) {
      score += Math.sign(gapPct);
      why.push(`Opened ${gapPct > 0 ? 'up' : 'down'} ${Math.abs(gapPct).toFixed(1)}%`);
    }

    if (Math.abs(score) < 1.5) continue;
    const bias = score > 0 ? 'BUY' : 'SELL';
    items.push({
      symbol,
      name,
      bias,
      score: round2(Math.abs(score)),
      why,
      news: news && { label: news.label, title: news.title, reaction: news.reaction },
      levels: { prevClose: round2(prior.close), high: round2(prior.high), low: round2(prior.low) },
      trigger: bias === 'BUY' ? { text: "Look for buys above yesterday's high", price: round2(prior.high) } : { text: "Look for sells below yesterday's low", price: round2(prior.low) },
    });
  }
  items.sort((a, b) => b.score - a.score);

  const nifty = market.getTick('NIFTY 50')?.changePct ?? null;
  return {
    generatedAt: now.toISOString(),
    mood: nifty == null ? null : { niftyChangePct: round2(nifty), text: Math.abs(nifty) < 0.3 ? 'Nifty 50 is flat' : nifty > 0 ? 'Nifty 50 is up' : 'Nifty 50 is down' },
    items: items.slice(0, MAX_ITEMS),
  };
}
