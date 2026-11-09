import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minuteRows, replayPriceStop, replayIndexStop, pathSummary, lessons } from '../src/replay/path.js';
import { closedBars5, entryBarIndex, entryReasons, sourceOf } from '../src/replay/why.js';
import { buildEvents, estimateOption, firstStopFromNote } from '../src/replay/service.js';

// 09:30 IST on 3 Nov 2026, in epoch seconds
const T0 = Date.UTC(2026, 10, 3, 4, 0) / 1000;
const candle = (i, close, { high = close + 0.5, low = close - 0.5, open = close } = {}) => ({ time: T0 + i * 60, open, high, low, close, volume: 0 });

test('minute rows: P&L of each minute from entry to exit, the last minute at the real exit price', () => {
  const candles = [candle(-1, 100), candle(0, 101), candle(1, 104), candle(2, 108), candle(3, 96), candle(4, 95)];
  const rows = minuteRows({ candles, long: true, avg: 100, qty: 130, entryTime: T0 + 10, exitTime: T0 + 4 * 60 + 20, exitPrice: 94.5 });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.min), [1, 2, 3, 4, 5]);
  assert.equal(rows[0].pnl, 130); // 101 - 100
  assert.equal(rows[2].pnl, 1040); // 108 - 100
  assert.equal(rows[2].best, 1105); // high 108.5
  assert.equal(rows.at(-1).pnl, -715); // exit at 94.5, not the candle close
  const s = pathSummary(rows);
  assert.equal(s.peak, 1105);
  assert.equal(s.peakMin, 3);
  assert.equal(s.final, -715);
  assert.equal(s.gaveBack, 1820);
  assert.equal(s.minutesUp, 3);
});

test('minute rows: a short sale makes money when the price falls', () => {
  const rows = minuteRows({ candles: [candle(0, 100), candle(1, 98)], long: false, avg: 100, qty: 10, entryTime: T0, exitTime: T0 + 60, exitPrice: 98 });
  assert.equal(rows[1].pnl, 20);
  assert.equal(rows[1].best, 25); // the low 97.5
});

test('price stop: the profit ladder moves the stop only up, one line per new row', () => {
  const candles = [candle(0, 100), candle(1, 110, { high: 112 }), candle(2, 125, { high: 126 }), candle(3, 118), candle(4, 101)];
  const rows = minuteRows({ candles, long: true, avg: 100, qty: 100, entryTime: T0, exitTime: T0 + 240, exitPrice: 101 });
  const events = replayPriceStop(rows, { long: true, avg: 100, qty: 100, exits: { stopLoss: 90, lockSteps: [{ at: 1000, keep: 500 }, { at: 2000, keep: 1500 }], segment: 'OPT' } });
  assert.equal(rows[0].stop, 90);
  assert.equal(rows[1].stop, 107); // profit at the high 1,200 -> keeps 1,200 - 500 = 700 -> 107
  assert.equal(rows[2].stop, 121); // profit 2,600 on the second row -> keeps 2,600 - 500 = 2,100 -> 121
  assert.equal(rows[3].stop, 121); // never moves back
  assert.equal(events.length, 2);
  assert.match(events[0].text, /ladder row 1/);
  assert.match(events[1].text, /ladder row 2/);
  assert.equal(events[1].keeps, 2100);
});

test('price stop: a ladder that starts above the best profit never moves the stop', () => {
  const rows = minuteRows({ candles: [candle(0, 100), candle(1, 120), candle(2, 70)], long: true, avg: 100, qty: 130, entryTime: T0, exitTime: T0 + 120, exitPrice: 70 });
  const events = replayPriceStop(rows, { long: true, avg: 100, qty: 130, exits: { stopLoss: 77, lockSteps: [{ at: 3500, keep: 1500 }], segment: 'OPT' } });
  assert.equal(events.length, 0);
  assert.ok(rows.every((r) => r.stop === 77));
  const said = lessons({ summary: pathSummary(rows), net: -4100, gross: -3900, charges: 200, plannedRisk: 2990, exits: { lockSteps: [{ at: 3500, keep: 1500 }] }, qty: 130, lots: 2, lotSize: 65, segment: 'OPT', exitLabel: 'Stopped out', stopEvents: events });
  const text = said.map((l) => l.text).join('\n');
  assert.match(text, /It was up \+₹2,665/);
  assert.match(text, /lock starts at \+₹3,500/);
  assert.match(text, /plan risked ₹2,990, the loss was ₹3,900/);
  assert.match(text, /2 lots of 65 = 130 units/);
});

test('index stop: break-even, then the trail, then the close past it', () => {
  const premium = [0, 1, 2, 3, 4].map((i) => candle(i, 100));
  const idx = [candle(0, 24000, { high: 24002 }), candle(1, 24015, { high: 24021 }), candle(2, 24040, { high: 24045 }), candle(3, 24030), candle(4, 24010)];
  const rows = minuteRows({ candles: premium, long: true, avg: 100, qty: 65, entryTime: T0, exitTime: T0 + 240 });
  const events = replayIndexStop(rows, { candles: idx, long: true, entrySpot: 24000, stopSpot: 23980, breakEven: 20, trail: { points: 25, start: 40 } });
  assert.deepEqual(rows.map((r) => r.spotStop), [23980, 24000, 24020, 24020, 24020]);
  assert.deepEqual(events.map((e) => e.kind), ['breakEven', 'trail', 'spotHit']);
});

test('the first chart stop is read from the trader note', () => {
  assert.equal(firstStopFromNote('Breakout of the last hour; stop at NIFTY 24350.5'), 24350.5);
  assert.equal(firstStopFromNote(null), null);
});

test('estimated premiums start at the real entry price', () => {
  const idx = [candle(0, 24000), candle(1, 24020), candle(2, 23990)];
  const est = estimateOption({ symbol: 'NIFTY-20261110-24000-CE', indexMinutes: idx, entryTime: T0 + 5, entryPrice: 150 });
  assert.equal(est.length, 3);
  assert.ok(Math.abs(est[0].close - 150) <= 0.1);
  assert.ok(est[1].close > est[0].close && est[2].close < est[0].close);
});

test('events are in time order, entry first and exit last', () => {
  const rows = minuteRows({ candles: [candle(0, 100), candle(1, 104), candle(2, 96)], long: true, avg: 100, qty: 50, entryTime: T0, exitTime: T0 + 120, exitPrice: 96 });
  const ev = buildEvents({ rows, entryTime: T0, exitTime: T0 + 120, avg: 100, long: true, open: false, exitLabel: 'Stopped out', exitPrice: 96, summary: pathSummary(rows), stopEvents: [], indexEvents: [], initialStop: 96, index: null });
  assert.equal(ev[0].kind, 'entry');
  assert.equal(ev.at(-1).kind, 'exit');
  assert.ok(ev.some((e) => e.kind === 'peak'));
  assert.ok(ev.some((e) => e.kind === 'red' && /Back into loss/.test(e.text)));
});

test('source of a trade: a combination by its saved name or snapshot, a pattern by its label, else the setup', () => {
  const combos = [{ id: 'hi', name: 'High break', conds: ['aboveEma20'], need: 1, window: 3 }];
  assert.equal(sourceOf('Combination: High break', { combos }).combo.id, 'hi');
  assert.equal(sourceOf('Combo: Gone', { combos }).combo, null);
  assert.equal(sourceOf('Combination: Edited', { combos, detailCombo: { id: 'x', name: 'Edited', conds: ['rsiAbove50'] } }).saved, true);
  assert.equal(sourceOf('Breakout of the last hour').technique.key, 'breakout');
  assert.equal(sourceOf('VWAP pullback').kind, 'setup');
  assert.equal(sourceOf(null).kind, 'manual');
});

test('entry reasons: each check of the combination at the entry bar, the readings, and whether the study sees it', () => {
  // three days of a slow rise, 1-minute candles from 09:15 to 15:30
  const c1 = [];
  const day0 = Date.UTC(2026, 10, 2, 3, 45) / 1000; // 09:15 IST, 2 Nov
  let p = 24000;
  for (let d = 0; d < 3; d++) {
    for (let m = 0; m < 375; m++) {
      p += Math.sin((d * 375 + m) / 17) * 2 + 0.15;
      c1.push({ time: day0 + d * 86400 + m * 60, open: p - 0.5, high: p + 1.5, low: p - 1.5, close: p, volume: 0 });
    }
  }
  const bars5 = closedBars5(c1);
  const entryTime = bars5[bars5.length - 30].time + 300 + 5;
  assert.equal(entryBarIndex(bars5, entryTime), bars5.length - 30);
  const combo = { id: 'trend', name: 'Trend', conds: ['aboveEma20', 'rsiAbove50'], need: 2, window: 3 };
  const out = entryReasons({ bars5, entryTime, side: 'CE', source: { kind: 'combo', combo } });
  assert.equal(out.conditions.length, 2);
  assert.ok(out.conditions.every((c) => typeof c.held === 'boolean'));
  assert.ok(out.readings.some((r) => r.label === 'RSI 14'));
  assert.equal(typeof out.study.matched, 'boolean');
  assert.match(out.study.text, /study/);
});

// three days of a gentle wave, 1-minute candles from 09:15 to 15:30
function wave() {
  const c1 = [];
  const day0 = Date.UTC(2026, 10, 2, 3, 45) / 1000; // 09:15 IST, 2 Nov
  let p = 24000;
  for (let d = 0; d < 3; d++) {
    for (let m = 0; m < 375; m++) {
      p += Math.sin((d * 375 + m) / 17) * 2 + 0.15;
      c1.push({ time: day0 + d * 86400 + m * 60, open: p - 0.5, high: p + 1.5, low: p - 1.5, close: p, volume: 0 });
    }
  }
  return c1;
}

test('a combination never fires on a bar where fewer checks hold than it needs', async () => {
  const { comboSignals, heldConditions } = await import('../src/combos/combos.js');
  const { buildChart } = await import('../src/combos/conditions.js');
  const chart = buildChart(closedBars5(wave()));
  const combos = [
    { id: 'a', name: 'A', conds: ['p_breakout', 'keltnerUpper', 'aroonUp', 'rsiRising', 'macdAbove'], need: 5, window: 3 },
    { id: 'b', name: 'B', conds: ['aboveEma20', 'rsiAbove50', 'macdAbove'], need: 3, window: 3 },
    { id: 'c', name: 'C', conds: ['aboveEma20', 'rsiRising', 'aroonUp', 'macdAbove'], need: 2, window: 2 },
  ];
  let fired = 0;
  for (const combo of combos) {
    for (const s of comboSignals(chart, combo, { from: 15, windows: false })) {
      fired++;
      const held = heldConditions(chart, combo, s.side === 'CE' ? 1 : -1, s.i).filter((c) => c.held).length;
      assert.ok(held >= combo.need, `${combo.id} fired at bar ${s.i} with ${held} of ${combo.need}`);
    }
  }
  assert.ok(fired > 0);
});

test('entry reasons: a buy "on the minute" is read on the bar still forming, and says what changed by its close', () => {
  const c1 = wave();
  // the last day, at 13:00 IST: two minutes shoot up, then the rest of the 5-minute bar falls back below where it started
  const slot = Date.UTC(2026, 10, 4, 7, 30) / 1000;
  const k = c1.findIndex((c) => c.time === slot);
  const base = c1[k - 1].close;
  const path = [base + 40, base + 90, base + 20, base - 10, base - 20];
  path.forEach((p, n) => Object.assign(c1[k + n], { open: n ? path[n - 1] : base, high: Math.max(p, n ? path[n - 1] : base) + 1, low: Math.min(p, n ? path[n - 1] : base) - 1, close: p }));
  const bars5 = closedBars5(c1);
  const combo = { id: 'k', name: 'Keltner', conds: ['keltnerUpper'], need: 1, window: 3 };
  const entryTime = slot + 120 + 2; // 13:02:02, the price of the 13:02 minute mark
  const early = entryReasons({ bars5, entryTime, side: 'CE', source: { kind: 'combo', combo }, clock: 'minute', c1, spot: base + 90 });
  assert.equal(early.bar.forming, true);
  assert.equal(early.bar.time, slot);
  assert.equal(early.bar.upTo, slot + 120);
  assert.equal(early.conditions[0].held, true); // what the live trader saw at 13:02
  assert.equal(early.atClose.held, 0); // gone by 13:05
  assert.deepEqual(early.atClose.failed, ['Close above the upper Keltner channel']);
  assert.equal(early.study.matched, false);
  assert.match(early.study.text, /before this bar closed/);
  // read as a bar-close entry (the old way), the same trade shows the check failing on the previous bar
  const late = entryReasons({ bars5, entryTime, side: 'CE', source: { kind: 'combo', combo } });
  assert.equal(late.bar.time, slot - 300);
  assert.equal(late.bar.forming, undefined);
});

test('entry reasons: live and study agree only on the same bar, not the one next to it', () => {
  const bars5 = closedBars5(wave());
  const combo = { id: 'trend', name: 'Trend', conds: ['aboveEma20', 'rsiAbove50'], need: 2, window: 3 };
  const first = entryReasons({ bars5, entryTime: bars5[60].time + 305, side: 'CE', source: { kind: 'combo', combo } });
  const times = first.study.times;
  assert.ok(times.length > 0);
  const at = bars5.findIndex((b) => b.time + 300 === times[0]);
  assert.equal(entryReasons({ bars5, entryTime: bars5[at].time + 305, side: 'CE', source: { kind: 'combo', combo } }).study.matched, true);
  assert.equal(entryReasons({ bars5, entryTime: bars5[at + 1].time + 305, side: 'CE', source: { kind: 'combo', combo } }).study.matched, false);
});

test('entry reasons: a put says its checks are read upside down', () => {
  const bars5 = closedBars5(wave());
  const out = entryReasons({ bars5, entryTime: bars5[100].time + 305, side: 'PE', source: { kind: 'combo', combo: { id: 't', name: 'T', conds: ['aboveEma20'], need: 1, window: 3 } } });
  assert.equal(out.mirrored, true);
});
