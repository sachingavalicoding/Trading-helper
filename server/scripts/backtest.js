// Backtests the scanner on history and compares the enhanced rules with the old ones, in rupees
// after charges and slippage.
//   npm run backtest -- --days 10 --holdout 3 --risk 1000 --slippage 0.05 --stop-scale 1 --breakeven 0 --symbols INFY,TCS
// --stop-scale 0.8 makes every stop 20% tighter than the scanner's, 1.3 makes it 30% wider, to test them on the same days.
// --breakeven 0.2 adds an early rung in the live-exit replay: at +0.2% the stop moves up to keep 0.08%, to see if securing profit sooner pays.
// The most recent `holdout` sessions are the unseen test; the `days` before them are the tuning
// period. Use it with live Upstox data. On the mock feed the history is random, so the result means nothing.
import { env } from '../src/config/env.js';
import { createProvider } from '../src/market/providers/index.js';
import { MarketDataService } from '../src/market/MarketDataService.js';
import { NIFTY50 } from '../src/market/instruments.js';
import { replayStock, LADDER } from '../src/scanner/replay.js';
import { evaluate, evaluateBy, targetTable } from '../src/scanner/backtest.js';
import { istParts } from '../src/market/marketHours.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const days = Number(arg('days', 10));
const holdout = Number(arg('holdout', 3));
const opts = { riskAmount: Number(arg('risk', 1000)), slippagePct: Number(arg('slippage', 0.05)) };
const stopScale = Number(arg('stop-scale', 1));
const breakeven = Number(arg('breakeven', 0)); // percent of the entry price, e.g. 0.2 adds an early rung: at +0.2% the stop keeps 0.08%
const early = breakeven * 0.4;
const ladder = breakeven > 0 ? [[breakeven, early], ...LADDER.filter(([at, keep]) => at > breakeven && keep > early)] : LADDER;
const symbols = arg('symbols') ? arg('symbols').split(',').map((s) => s.trim().toUpperCase()) : NIFTY50.map((s) => s.symbol);

const market = new MarketDataService(createProvider(env), { holidays: env.nseHolidays });
await market.start();
if (env.provider === 'mock') console.log('WARNING: mock feed, history is random. Results mean nothing.\n');
const nifty = await market.getCandles('NIFTY 50', '1m').catch(() => null);
const history = {};
for (const symbol of symbols) history[symbol] = await market.getCandles(symbol, '1m').catch(() => null);

const run = (legacy, skipDays, n, exits = 'target1', scale = 1) => symbols.flatMap((symbol) => (history[symbol] ? replayStock({ symbol, c1: history[symbol], nifty, days: n, legacy, skipDays, exits, stopScale: scale, ladder }) : []));
const money = (n) => (n == null ? '-' : `₹${n.toLocaleString('en-IN')}`);
const line = (label, e) => `${label.padEnd(22)} ${String(e.trades).padStart(4)} trades  win ${String(e.winRate ?? '-').padStart(3)}%  avg win ${money(e.avgWin)}  avg loss ${money(e.avgLoss)}  expectancy ${money(e.expectancy)}  PF ${e.profitFactor ?? '-'}  net ${money(e.totalNet)}  charges ${money(e.totalCharges)}  max drawdown ${money(e.maxDrawdown)}`;

console.log(`${symbols.length} stocks, risk ${money(opts.riskAmount)} per trade, slippage ${opts.slippagePct}% each way, charges included.\nNo order book in replay; a bar that touches both stop and target counts as the stop.\n"Live exits" replays what the auto trader does after buying: the climbing stop (no sale target) and the 15:15 square-off.${stopScale !== 1 ? ` Stops are scaled by ${stopScale}.` : ''}${breakeven > 0 ? ` An extra rung moves the stop up at +${breakeven}%.` : ''}\n`);
for (const [name, skip, n] of [['Tuning period', holdout, days], ['Unseen period', 0, holdout]]) {
  console.log(`${name}`);
  const old = run(true, skip, n);
  const now = run(false, skip, n, 'target1', stopScale);
  const live = run(false, skip, n, 'live', stopScale);
  console.log(line('  Old rules', evaluate(old, opts)));
  console.log(line('  Enhanced, sell at T1', evaluate(now, opts)));
  console.log(line('  Enhanced, live exits', evaluate(live, opts)));
  if (name === 'Unseen period') {
    console.log('  Live exits, by setup, hour and how they ended:');
    for (const r of evaluateBy(live, (i) => i.setup, opts)) console.log(line(`    ${r.key}`, r));
    for (const r of evaluateBy(live, (i) => `${String(Math.floor(istParts(new Date(i.openedAt)).minutes / 60)).padStart(2, '0')}:00`, opts)) console.log(line(`    ${r.key}`, r));
    for (const r of evaluateBy(live, (i) => i.exit, opts)) console.log(line(`    ${r.key}`, r));
    console.log('  First target, by risk multiple: share of ideas that ran that far before their stop, and the average result in risk units (before charges):');
    for (const t of targetTable(live)) console.log(`    ${String(t.target).padStart(4)}R  reached ${String(t.hitRate ?? '-').padStart(3)}%  expectancy ${t.expectancyR ?? '-'}R`);
  }
  console.log();
}
console.log('Few trades means the numbers are noise. Judge on the unseen period only.');
await market.stop();
process.exit(0);
