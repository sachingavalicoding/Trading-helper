import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { prepare, turnoverSeries } from '../study/patterns.js';
import { breadthSeries } from '../study/optionsStudy.js';
import { buildChart, CONDITION_BY_KEY, usable } from '../combos/conditions.js';
import { comboSignals, DEFAULT_WINDOW } from '../combos/combos.js';

// "Where would this have bought?": one check (or a combination of checks) on the last few days of the Nifty chart, as the info button shows it.
// Every time it turned true on a closed 5-minute bar (the same freshness and cooldown the live trader uses) is an entry, with how far the
// index went in that direction over the next 30 minutes. It reads history and changes nothing.

const DAY = (t) => Math.floor((t + 19800) / 86400);
export const EXAMPLE_DAYS = [3, 5, 10];
export const AHEAD_BARS = 6; // 30 minutes of 5-minute bars
const round = (n) => Math.round(n * 100) / 100;

/**
 * @param nifty1   Nifty 1-minute candles, oldest first (a few days more than `days`, so the indicators have warmed up)
 * @param stocks5  { SYMBOL: 5-minute candles } of the 50 stocks, for checks that need breadth or volume (may be null)
 * @param keys     the check keys; more than one is a combination (`need` of them true within `window` bars)
 */
export function checkExamples({ nifty1, stocks5 = null, keys, need = null, window = null, days = 5 }) {
  const conds = keys.map((k) => CONDITION_BY_KEY.get(k)).filter(Boolean);
  if (!conds.length) return { error: 'Unknown check' };
  let bars5 = aggregateCandles(nifty1, '5m');
  if (bars5.length && bars5.at(-1).time + 300 > nifty1.at(-1).time + 60) bars5 = bars5.slice(0, -1); // the forming bar is not a closed bar
  const dayList = [...new Set(bars5.map((b) => DAY(b.time)))].sort((a, b) => a - b);
  const shown = new Set(dayList.slice(-days));
  const breadth = stocks5 ? breadthSeries(bars5, stocks5) : null;
  const flow = stocks5 ? turnoverSeries(bars5, stocks5) : null;
  const prep = prepare(bars5, breadth, flow);
  const chart = buildChart(bars5, { breadth, flow, prep });
  const missing = conds.filter((c) => !usable(c, chart.have));
  if (missing.length) return { error: `${missing.map((c) => c.label).join(', ')} needs the 50-stock data, which is not saved yet (Research > Saved data > Download).` };
  const combo = { id: 'example', name: conds.map((c) => c.label).join(' + '), conds: conds.map((c) => c.key), need: Math.min(need || conds.length, conds.length), window: conds.length > 1 ? window || DEFAULT_WINDOW : 1 };
  const first = bars5.findIndex((b) => shown.has(DAY(b.time)));
  const signals = first < 0 ? [] : comboSignals(chart, combo, { from: Math.max(16, first), windows: true });
  const entries = signals.map((s) => {
    const d = s.side === 'CE' ? 1 : -1;
    const ahead = bars5.slice(s.i + 1, s.i + 1 + AHEAD_BARS).filter((b) => DAY(b.time) === DAY(bars5[s.i].time));
    const entry = bars5[s.i].close;
    const best = ahead.length ? Math.max(...ahead.map((b) => d * ((d > 0 ? b.high : b.low) - entry))) : null;
    const worst = ahead.length ? Math.min(...ahead.map((b) => d * ((d > 0 ? b.low : b.high) - entry))) : null;
    const after = ahead.length ? d * (ahead.at(-1).close - entry) : null;
    return { time: bars5[s.i].time + 300, i: s.i, side: s.side, price: round(entry), stop: round(s.stop), after: after == null ? null : round(after), best: best == null ? null : round(best), worst: worst == null ? null : round(worst), went: after == null ? null : after > 0 ? 'right' : 'wrong' };
  });
  const out = bars5.filter((b) => shown.has(DAY(b.time))).map((b) => ({ time: b.time, open: round(b.open), high: round(b.high), low: round(b.low), close: round(b.close) }));
  const done = entries.filter((e) => e.after != null);
  return {
    name: combo.name,
    days: shown.size,
    bars: out,
    entries,
    summary: {
      entries: entries.length,
      calls: entries.filter((e) => e.side === 'CE').length,
      puts: entries.filter((e) => e.side === 'PE').length,
      right: done.filter((e) => e.went === 'right').length,
      avgAfter: done.length ? round(done.reduce((a, e) => a + e.after, 0) / done.length) : null,
      avgBest: done.length ? round(done.reduce((a, e) => a + e.best, 0) / done.length) : null,
    },
  };
}
