import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, findSignals, turnoverSeries, vwapSeries, TECHNIQUES, available } from '../src/study/patterns.js';

// Monday 12 Oct 2026, 09:15 IST
const OPEN = Date.UTC(2026, 9, 12, 3, 45) / 1000;
const DAY = 86400;

const barsFrom = (closes, start = OPEN) =>
  closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { time: start + i * 300, open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c, volume: 0 };
  });
const only = (bars, key, flow = null, breadth = null) => findSignals(prepare(bars, breadth, flow), { only: [key] });
const flat = (n, at = 24000) => Array.from({ length: n }, (_, i) => at + (i % 2 ? 3 : -3));

test('the 30-minute opening range breaks once, after 09:45, and a put is the mirror', () => {
  const closes = [...flat(6, 24008), ...flat(9, 24008), 24030];
  const calls = only(barsFrom(closes), 'orb30');
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].side, 'CE');
  assert.equal(calls[0].i, 15);
  assert.ok(calls[0].stop < 24005, `stop ${calls[0].stop}`);
  const mirror = barsFrom(closes).map((b) => ({ ...b, open: 48000 - b.open, high: 48000 - b.low, low: 48000 - b.high, close: 48000 - b.close }));
  assert.deepEqual(only(mirror, 'orb30').map((s) => s.side), ['PE']);
  assert.deepEqual(only(barsFrom([...flat(6, 24008), ...flat(10, 24008)]), 'orb30'), [], 'no break, no signal');
});

test("yesterday's high is broken only by the first close of the day above it", () => {
  const yesterday = barsFrom([...flat(10, 24000), 24020, 24040, 24050, 24045, 24040, 24035, 24030, 24025, 24020, 24015], OPEN);
  const today = barsFrom([...flat(14, 24020), 24070, 24075], OPEN + DAY);
  const signals = only([...yesterday, ...today], 'pdBreak');
  assert.equal(signals.length, 1, JSON.stringify(signals));
  assert.equal(signals[0].side, 'CE');
  assert.equal(signals[0].i, yesterday.length + 14, 'the first close above, not the second');
  assert.deepEqual(only(yesterday, 'pdBreak'), [], 'the first day has no yesterday');
});

test('a momentum bar is a big bar that closes at its high above the last six bars', () => {
  const bars = barsFrom([...flat(15, 24010), 24010]);
  bars[15] = { ...bars[15], open: 24010, high: 24046, low: 24008, close: 24045 };
  const signals = only(bars, 'momentumBar');
  assert.equal(signals.length, 1, JSON.stringify(signals));
  assert.equal(signals[0].side, 'CE');
  bars[15] = { ...bars[15], close: 24030 }; // closes well off its high
  assert.deepEqual(only(bars, 'momentumBar'), []);
});

test('turnover and VWAP come from the 50 stocks, and a bar without enough stocks breaks the VWAP for the rest of the day', () => {
  const bars5 = barsFrom(flat(12));
  const stock = (volume, skip = -1) => bars5.filter((_, i) => i !== skip).map((b) => ({ ...b, close: 100, volume }));
  const stocks = Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`S${k}`, stock(10)]));
  const turn = turnoverSeries(bars5, stocks);
  assert.equal(turn.length, 12);
  assert.equal(turn[0], 40 * 100 * 10);
  assert.equal(turnoverSeries(bars5, { S0: stock(10) }), null, 'fewer than 30 stocks: no volume');
  const day = bars5.map(() => 0);
  const vwap = vwapSeries(bars5, turn, day);
  assert.ok(Math.abs(vwap[0] - (bars5[0].high + bars5[0].low + bars5[0].close) / 3) < 1e-9);
  const holes = turn.map((x, i) => (i === 5 ? null : x));
  const broken = vwapSeries(bars5, holes, day);
  assert.ok(broken[4] != null && broken.slice(5).every((x) => x == null));
  assert.equal(turnoverSeries(bars5, Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`S${k}`, stock(0)]))), null, 'all zero volume: no volume');
});

test('volume and VWAP patterns appear only when the volume is known, and need heavy volume', () => {
  // quiet and flat, then a close through the top of the last hour
  const closes = [...flat(15, 24000), 24012];
  const bars = barsFrom(closes);
  const quiet = bars.map(() => 1000);
  const heavy = bars.map((_, i) => (i === 15 ? 2500 : 1000));
  assert.equal(only(bars, 'breakout').length, 1, 'the plain breakout is there');
  assert.deepEqual(only(bars, 'volumeBreakout'), [], 'no volume known, so the volume pattern is not tested');
  assert.deepEqual(only(bars, 'volumeBreakout', quiet), [], 'on ordinary volume it is not a volume breakout');
  assert.deepEqual(only(bars, 'volumeBreakout', heavy).map((s) => s.side), ['CE']);
});

test('VWAP reclaim: closes under VWAP for three bars, then back above on heavy volume', () => {
  const closes = [...flat(12, 24020), 24006, 24004, 24005, 24024];
  const bars = barsFrom(closes);
  const heavy = bars.map((_, i) => (i === 15 ? 2500 : 1000));
  const calls = only(bars, 'vwapReclaim', heavy);
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].side, 'CE');
  assert.deepEqual(only(bars, 'vwapReclaim', bars.map(() => 1000)), [], 'ordinary volume is not enough');
});

test('VWAP pullback: held above a rising VWAP, touches it, closes above the previous bar high', () => {
  const rise = Array.from({ length: 14 }, (_, i) => 24000 + i * 3);
  const closes = [...rise, 24040, 24042, 24040, 24036, 24030, 24024, 24020, 24032];
  const bars = barsFrom(closes);
  const signals = only(bars, 'vwapPullback', bars.map(() => 1000));
  assert.ok(signals.some((s) => s.side === 'CE'), JSON.stringify(signals));
  assert.deepEqual(only(bars, 'vwapPullback'), [], 'no volume known: not tested');
});

test('volume climax: a heavy bar at a 20-bar low that closes in its top half', () => {
  const fall = Array.from({ length: 20 }, (_, i) => 24100 - i * 5);
  const bars = barsFrom([...fall, 24000]);
  bars[20] = { ...bars[20], open: 24005, high: 24012, low: 23992, close: 24010 };
  const heavy = bars.map((_, i) => (i === 20 ? 3000 : 1000));
  const calls = only(bars, 'volumeClimax', heavy);
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].side, 'CE');
  assert.deepEqual(only(bars, 'volumeClimax', bars.map(() => 1000)), []);
});

test('the new techniques are flagged so the old "together" rows keep their meaning, and the volume ones are held back without volume', () => {
  const extra = TECHNIQUES.filter((t) => t.extra).map((t) => t.key);
  assert.deepEqual(extra.sort(), ['momentumBar', 'orb30', 'pdBreak', 'volumeBreakout', 'volumeClimax', 'vwapPullback', 'vwapReclaim']);
  const flowKeys = TECHNIQUES.filter((t) => !available(t, { flow: false, breadth: true })).map((t) => t.key);
  assert.deepEqual(flowKeys.sort(), ['vwapPullback', 'vwapReclaim', 'volumeBreakout', 'volumeClimax'].sort());
});

test('Review lists the volume and VWAP patterns only when the 50 stocks are saved, and says how to get them otherwise', async () => {
  const { chartPatterns, reviewPatterns, FLOW_NOTE } = await import('../src/review/patterns.js');
  const keys = (list) => list.map((p) => p.key);
  assert.ok(!keys(chartPatterns(false)).includes('vwapReclaim') && keys(chartPatterns(false)).includes('pdBreak'));
  assert.ok(keys(chartPatterns(true)).includes('vwapReclaim') && !keys(chartPatterns(true)).includes('breadth'));
  const c1 = Array.from({ length: 80 }, (_, i) => ({ time: OPEN + i * 60, open: 24000, high: 24002, low: 23998, close: 24000, volume: 0 }));
  const params = { iv: 0.14, lockStart: 1000, lockGap: 250, lotSize: 75, holidays: [], expiryWeekday: 2, lossLimit: 1500, maxLots: 2 };
  const none = reviewPatterns({ c1, day: '2026-10-12', params });
  assert.equal(none.note, FLOW_NOTE);
  assert.ok(!keys(none.patterns).includes('volumeBreakout'));
  const bars5 = barsFrom(flat(16));
  const stocks5 = Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`S${k}`, bars5.map((b) => ({ ...b, close: 100, volume: 10 }))]));
  const c1Long = Array.from({ length: 80 }, (_, i) => ({ time: OPEN + i * 60, open: 24000, high: 24002, low: 23998, close: 24000, volume: 0 }));
  const withFlow = reviewPatterns({ c1: c1Long, day: '2026-10-12', params, stocks5 });
  assert.equal(withFlow.note, null);
  assert.ok(keys(withFlow.patterns).includes('volumeBreakout'));
});
