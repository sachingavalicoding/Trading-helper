// Replays the scanner over recent history and prints how its ideas would have ended.
//   npm run replay -- --days 3 --symbols INFY,TCS,SBIN
// Use it with live Upstox data (MARKET_DATA_PROVIDER=upstox, after logging in). On the mock
// feed the history is random, so the result means nothing.
import { env } from '../src/config/env.js';
import { createProvider } from '../src/market/providers/index.js';
import { MarketDataService } from '../src/market/MarketDataService.js';
import { NIFTY50 } from '../src/market/instruments.js';
import { replayStock } from '../src/scanner/replay.js';
import { summarizeIdeas } from '../src/scanner/stats.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const days = Number(arg('days', 3));
const symbols = arg('symbols') ? arg('symbols').split(',').map((s) => s.trim().toUpperCase()) : NIFTY50.map((s) => s.symbol);

const market = new MarketDataService(createProvider(env), { holidays: env.nseHolidays });
await market.start();
if (env.provider === 'mock') console.log('WARNING: mock feed, history is random. Results mean nothing.\n');

const nifty = await market.getCandles('NIFTY 50', '1m').catch(() => null);
const ideas = [];
for (const symbol of symbols) {
  try {
    ideas.push(...replayStock({ symbol, c1: await market.getCandles(symbol, '1m'), nifty, days }));
  } catch (err) {
    console.log(`${symbol}: skipped (${err.message})`);
  }
}

const s = summarizeIdeas(ideas);
const row = (label, b) => `${String(label).padEnd(26)} ${String(b.count).padStart(4)} ideas  win ${String(b.winRate ?? '-').padStart(3)}%  stopped ${String(b.stops).padStart(3)}  avg ${String(b.avgR ?? '-').padStart(5)}R${b.enough ? '' : '  (too few to trust)'}`;
console.log(`Replay of ${symbols.length} stocks over the last ${days} sessions (no order book; ties count as stopped)\n`);
console.log(row('All ideas', s.overall));
for (const r of s.bySetup) console.log(row(`  ${r.key}`, r));
for (const r of s.bySide) console.log(row(`  ${r.key}`, r));
for (const r of s.byHour) console.log(row(`  ${r.label}`, r));
await market.stop();
process.exit(0);
