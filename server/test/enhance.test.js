import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDaily } from '../src/scanner/daily.js';
import { adx, supertrend, obvChange, squeezeRelease } from '../src/signals/indicators.js';
import { pivotsFrom, candleConfirms } from '../src/scanner/pivots.js';
import { followLive } from '../src/scanner/replay.js';
import { targetTable } from '../src/scanner/backtest.js';
import { scoreCandidate, adaptTargets, reachTargets, WEIGHTS, LEGACY_WEIGHTS, MIN_ADX } from '../src/scanner/evaluate.js';

const bars = (n, close) => Array.from({ length: n }, (_, i) => {
  const c = close(i);
  const p = close(Math.max(0, i - 1));
  return { time: i * 300, open: p, high: Math.max(p, c) + 0.3, low: Math.min(p, c) - 0.3, close: c, volume: 1000 };
});

test('ADX is high in a steady trend and low when price just zigzags', () => {
  assert.ok(adx(bars(80, (i) => 100 + i * 0.8)) > 40);
  assert.ok(adx(bars(80, (i) => 100 + 0.6 * Math.sin(i * 1.9) + 0.4 * Math.sin(i * 0.43))) < MIN_ADX);
  assert.equal(adx(bars(10, (i) => 100 + i)), null);
});

test('score weights add up to 100, old and new', () => {
  const total = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  assert.equal(total(WEIGHTS), 100);
  assert.equal(total(LEGACY_WEIGHTS), 100);
});

const ctx = (over = {}) => ({ ltp: 101, vwap: 100, trend5: 1, trend15: 1, relVol: 2, relStrength: 0.6, bookShare: 0.7, rsi: 60, macdHist: { now: 1, prev: 0.5 }, niftyChangePct: 0.3, vwapStretch: 0.5, news: null, adx: 30, emaStack: 1, sectorStrength: 0.4, month: { trend: 1, sessions: 22 }, supertrend: { dir: 1 }, obv: 500, squeeze: { released: true, side: 1 }, pivots: { tc: 100.5, bc: 99.5, widthPct: 0.2 }, candleOk: () => true, marketState: { niftyTrend: 1, breadthUp: 0.7 }, ...over });
const cand = (over = {}) => ({ side: 'BUY', status: 'ENTRY', entry: 101, stopLoss: 100.4, setup: 'X', ...over });

test('a clean trend, aligned EMAs and a backing sector earn full marks', () => {
  const r = scoreCandidate(ctx(), cand());
  assert.equal(r.score, 100);
  for (const id of ['adx', 'emaStack', 'sector']) assert.equal(r.checks.find((c) => c.id === id).points, WEIGHTS[id]);
});

test('a sideways stock earns no trend points but is not blocked', () => {
  const r = scoreCandidate(ctx({ adx: 10 }), cand());
  assert.ok(!r.blocked.length);
  assert.equal(r.checks.find((c) => c.id === 'adx').points, 0);
});

test('a sector moving the other way, or EMAs not lined up, earn nothing', () => {
  const r = scoreCandidate(ctx({ sectorStrength: -0.5, emaStack: 0 }), cand());
  assert.equal(r.checks.find((c) => c.id === 'sector').points, 0);
  assert.equal(r.checks.find((c) => c.id === 'emaStack').points, 0);
  const sell = scoreCandidate(ctx({ ltp: 99, trend5: -1, trend15: -1, rsi: 40, macdHist: { now: -1, prev: -0.5 }, relStrength: -0.6, bookShare: 0.3, emaStack: -1, sectorStrength: -0.4 }), cand({ side: 'SELL' }));
  assert.equal(sell.checks.find((c) => c.id === 'sector').points, WEIGHTS.sector);
});

test('missing ADX, EMA 50 or sector data never blocks and never invents points', () => {
  const r = scoreCandidate(ctx({ adx: null, emaStack: null, sectorStrength: null }), cand());
  assert.ok(!r.blocked.length);
  for (const id of ['adx', 'emaStack', 'sector']) assert.equal(r.checks.find((c) => c.id === id).points, 0);
});

test('legacy scoring has none of the new checks', () => {
  const r = scoreCandidate(ctx({ adx: 5 }), cand(), { legacy: true });
  assert.ok(!r.checks.some((c) => ['adx', 'emaStack', 'sector', 'monthly'].includes(c.id)));
});

test('an idea with a stock already up 7% today is not blocked, entry quality decides', () => {
  assert.ok(!scoreCandidate(ctx({ changePct: 7 }), cand()).blocked.length);
});

test('the last month earns points only when its trend agrees, and missing history earns none', () => {
  assert.equal(scoreCandidate(ctx(), cand()).checks.find((c) => c.id === 'monthly').points, WEIGHTS.monthly);
  assert.equal(scoreCandidate(ctx({ month: { trend: -1, sessions: 22 } }), cand()).checks.find((c) => c.id === 'monthly').points, 0);
  assert.equal(scoreCandidate(ctx({ month: null }), cand()).checks.find((c) => c.id === 'monthly').points, 0);
});

const dayBar = (i, close, spread = 1) => ({ time: 1_700_000_000 + i * 86400, open: close - 0.2, high: close + spread, low: close - spread, close, volume: 1000 });

test('summarizeDaily reads the monthly trend, range position and typical range', () => {
  const up = Array.from({ length: 25 }, (_, i) => dayBar(i, 100 + i));
  const today = Math.floor((up.at(-1).time + 19800) / 86400) + 1;
  const m = summarizeDaily(up, 123, today);
  assert.equal(m.trend, 1);
  assert.ok(m.rangePos > 0.8 && m.avgRangePct > 1);
  assert.equal(summarizeDaily(up.map((c) => ({ ...c, close: 200 - (c.close - 100) })), 90, today).trend, -1);
  assert.equal(summarizeDaily(up.slice(0, 10), 110, today), null);
  assert.equal(summarizeDaily(null, 110, today), null);
});

test("today's unfinished daily candle is not counted as a finished session", () => {
  const up = Array.from({ length: 20 }, (_, i) => dayBar(i, 100 + i));
  const today = Math.floor((up.at(-1).time + 19800) / 86400); // the 20th candle is today's, so only 19 are finished
  assert.equal(summarizeDaily(up, 120, today), null);
});

test('each new check earns points only when it agrees with the trade, and none when data is missing', () => {
  const pts = (over, id, side = cand()) => scoreCandidate(ctx(over), side).checks.find((c) => c.id === id).points;
  assert.equal(pts({}, 'supertrend'), WEIGHTS.supertrend);
  assert.equal(pts({ supertrend: { dir: -1 } }, 'supertrend'), 0);
  assert.equal(pts({ supertrend: null }, 'supertrend'), 0);
  assert.equal(pts({ obv: -5 }, 'obv'), 0);
  assert.equal(pts({ obv: null }, 'obv'), 0);
  assert.equal(pts({ squeeze: { released: true, side: -1 } }, 'squeeze'), 0);
  assert.equal(pts({ squeeze: { released: false, side: 1 } }, 'squeeze'), 0);
  assert.equal(pts({ candleOk: () => false }, 'candle'), 0);
  assert.equal(pts({ pivots: { tc: 102, bc: 101.5, widthPct: 0.2 } }, 'cpr'), 0); // price 101 is under the range
  assert.equal(pts({ pivots: null }, 'cpr'), 0);
  assert.equal(pts({ marketState: null }, 'niftyTrend'), 0);
  assert.equal(pts({ marketState: { niftyTrend: 1, breadthUp: 0.3 } }, 'niftyTrend'), 1); // only one of the two agrees
  assert.equal(pts({ marketState: { niftyTrend: -1, breadthUp: 0.3 } }, 'niftyTrend'), 0);
});

const bar = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });

test('candle confirmation wants a strong close or a rejection wick in the trade direction', () => {
  assert.equal(candleConfirms(bar(100, 102, 99.9, 101.9), 1), true); // strong green
  assert.equal(candleConfirms(bar(100, 100.3, 99.7, 100.05), 1), false); // indecision
  assert.equal(candleConfirms(bar(100, 100.4, 98, 100.3), 1), true); // long lower wick, closed back up
  assert.equal(candleConfirms(bar(100, 100.1, 98, 98.2), 1), false); // strong red is not a buy
  assert.equal(candleConfirms(bar(100, 100.1, 98, 98.1), -1), true);
  assert.equal(candleConfirms(null, 1), null);
});

test('pivots: central range and R1/S1 from yesterday, bad data gives none', () => {
  const p = pivotsFrom({ high: 110, low: 90, close: 100 });
  assert.equal(p.pivot, 100);
  assert.equal(p.r1, 110);
  assert.equal(p.s1, 90);
  assert.ok(p.tc >= p.bc && p.widthPct < 0.1);
  assert.equal(pivotsFrom({ high: 1, low: NaN, close: 1 }), null);
});

test('supertrend follows a steady move, flips on a reversal, and needs bars', () => {
  assert.equal(supertrend(bars(60, (i) => 100 + i)).dir, 1);
  assert.equal(supertrend(bars(60, (i) => 200 - i)).dir, -1);
  assert.equal(supertrend(bars(60, (i) => (i < 40 ? 100 + i : 140 - (i - 40) * 4))).dir, -1);
  assert.equal(supertrend(bars(5, (i) => i)), null);
});

test('on-balance volume rises when rising bars carry the volume', () => {
  assert.ok(obvChange(bars(40, (i) => 100 + i)) > 0);
  assert.ok(obvChange(bars(40, (i) => 100 - i)) < 0);
  assert.equal(obvChange(bars(5, (i) => i)), null);
});

test('a Bollinger squeeze that starts to widen is a release; a steadily noisy chart is not', () => {
  const quiet = (i) => 100 + (i % 2 ? 0.05 : -0.05);
  const series = Array.from({ length: 70 }, (_, i) => (i < 62 ? quiet(i) : 100 + (i - 61) * 0.8));
  assert.equal(squeezeRelease(bars(70, (i) => series[i])).released, true);
  assert.equal(squeezeRelease(bars(70, (i) => 100 + 2 * Math.sin(i))).released, false);
  assert.equal(squeezeRelease(bars(10, (i) => i)), null);
});

test('a target further away than the stock usually travels in a day is blocked, a reachable one is not', () => {
  const far = scoreCandidate(ctx({ month: { trend: 1, sessions: 22, avgRangePct: 1 } }), cand({ entry: 100, target1: 101.5 }));
  assert.ok(far.blocked.some((t) => /usually moves only/.test(t)));
  assert.ok(!scoreCandidate(ctx({ month: { trend: 1, sessions: 22, avgRangePct: 1 } }), cand({ entry: 100, target1: 100.6 })).blocked.length);
  assert.ok(!scoreCandidate(ctx({ month: null }), cand({ entry: 100, target1: 110 })).blocked.length, 'no daily history: nothing is assumed');
  assert.ok(!scoreCandidate(ctx({ month: { trend: 1, sessions: 22, avgRangePct: 1 } }), cand({ entry: 100, target1: 101.5 }), { legacy: true }).blocked.length);
});

test('a far target is pulled in to a slow stock\'s usual reach instead of dropping the idea, as long as it still pays', () => {
  const slow = ctx({ month: { trend: 1, sessions: 22, avgRangePct: 1 } });
  const far = cand({ entry: 100, stopLoss: 99.4, target1: 101.5, target2: 103, riskReward: 2.5, targetNote: 'the day high' });
  const a = adaptTargets(slow, far);
  assert.equal(a.target1, 100.8, '0.8 of a 1% day');
  assert.ok(a.target2 > a.target1 && a.target2 < far.target2, 'target 2 shrinks with it');
  assert.equal(a.riskReward, 1.33);
  assert.equal(a.adapted, true);
  assert.match(a.targetNote, /pulled in/);
  assert.equal(far.target1, 101.5, 'the input is not changed');
  assert.ok(!scoreCandidate(slow, a).blocked.length, 'the shortened idea passes the reach check');

  // a reachable target is left alone; so is a stock with no history
  assert.equal(adaptTargets(slow, cand({ entry: 100, stopLoss: 99.4, target1: 100.6, target2: 101 })).adapted, undefined);
  assert.equal(adaptTargets(ctx({ month: null }), far), far);
  // if the shortened target would not pay 1.2x the risk, the idea is left as it was and the reach check blocks it
  const tight = cand({ entry: 100, stopLoss: 99.1, target1: 101.5, target2: 103 });
  assert.equal(adaptTargets(slow, tight), tight);
  assert.ok(scoreCandidate(slow, tight).blocked.some((t) => /usually moves only/.test(t)));
});

test('the sale target never sits further than 0.8 of the usual daily range from the entry, and target 2 sits between', () => {
  const slow = ctx({ month: { trend: 1, sessions: 22, avgRangePct: 1 } });
  const far = cand({ entry: 100, stopLoss: 99.6, target1: 100.6, target2: 101.8, riskReward: 1.5, targetNote: 'the day high' });
  const r = reachTargets(slow, far);
  assert.equal(r.target3, 100.8, '0.8 of a 1% day, not 103');
  assert.equal(r.target2, 100.7);
  assert.ok(r.target1 < r.target2 && r.target2 < r.target3);
  assert.match(r.targetNote, /capped/);
  assert.equal(far.target3, undefined, 'the input is not changed');

  // a sale already inside the reach is left alone, and so is a stock with no history
  const near = cand({ entry: 100, stopLoss: 99.8, target1: 100.3, target2: 100.5 });
  assert.equal(reachTargets(slow, near).target3, 100.7);
  assert.equal(reachTargets(slow, near).target2, 100.5);
  assert.equal(reachTargets(ctx({ month: null }), far).target3, 103);
  // a short sale mirrors it
  const sell = cand({ side: 'SELL', entry: 100, stopLoss: 100.4, target1: 99.4, target2: 98.2 });
  assert.equal(reachTargets(slow, sell).target3, 99.2);
  // the sale stays at least half a risk past target 1, even if the day's reach is smaller than that
  const tiny = ctx({ month: { trend: 1, sessions: 22, avgRangePct: 0.3 } });
  const t = reachTargets(tiny, cand({ entry: 100, stopLoss: 99.6, target1: 100.2, target2: 100.4 }));
  assert.equal(t.target3, 100.4);
});

const T0 = Date.UTC(2026, 9, 27, 4, 0) / 1000; // 09:30 IST
const minute = (i, o, h, l, c) => ({ time: T0 + i * 60, open: o, high: h, low: l, close: c, volume: 1000 });
const live = { side: 'BUY', entry: 100, stopLoss: 99, target1: 101.5, target2: 102.5, target3: 104 };

test('live-style replay: the stop climbs behind the best price along the percent ladder, a hit stop above entry is a lock', () => {
  const bars = [minute(0, 100, 100, 100, 100), minute(1, 100, 100.7, 100.5, 100.6), minute(2, 100.6, 100.6, 100.2, 100.3), minute(3, 100.3, 102, 100.1, 102)];
  const r = followLive(bars, 0, live);
  assert.equal(r.exit, 'LOCK');
  assert.equal(r.status, 'LOCKED');
  assert.ok(Math.abs(r.exitPrice - 100.62) < 1e-9, '+0.7% is past the +0.6% rung, which trails 0.08% behind: stop at +0.62%');
  assert.equal(r.bestR, 0.7);
  assert.equal(r.runR, 2, 'it still ran to +2R before touching the original stop, whatever the exit did');
});

test('live-style replay: the original stop, no sale target, and no time exit', () => {
  assert.equal(followLive([minute(0, 100, 100, 100, 100), minute(1, 100, 100.2, 98.9, 99)], 0, live).exit, 'STOP');
  // the old sale target of 104 is ignored: the trade runs on to the 15:15 square-off
  const run = [minute(0, 100, 100, 100, 100), ...Array.from({ length: 40 }, (_, i) => minute(i + 1, 100 + i * 0.2, 100.2 + i * 0.2, 100 + i * 0.2, 100.2 + i * 0.2))];
  const up = followLive(run, 0, live);
  assert.equal(up.exit, 'SQUARE_OFF');
  assert.equal(up.exitPrice, run[run.length - 1].close);
  // a trade that sits flat for an hour is left alone
  const flat = [minute(0, 100, 100, 100, 100), ...Array.from({ length: 55 }, (_, i) => minute(i + 1, 99.9, 100.2, 99.7, 99.9))];
  const t = followLive(flat, 0, live);
  assert.equal(t.exit, 'SQUARE_OFF');
  assert.ok((flat[flat.length - 1].time - flat[0].time) / 60 >= 45);
});

test('the target table shows which first target would have paid best', () => {
  const t = targetTable([0, 0.6, 1.2, 2.5].map((runR) => ({ runR })));
  const at = (k) => t.find((x) => x.target === k);
  assert.equal(at(1).hitRate, 50);
  assert.equal(at(1).expectancyR, 0);
  assert.equal(at(0.5).hitRate, 75);
  assert.equal(at(0.5).expectancyR, 0.13, '0.75 x 0.5R - 0.25 x 1R');
});

import { newsGap } from '../src/scanner/setups.js';
import { entryWindow } from '../src/scanner/evaluate.js';

const gapCtx = (over = {}) => {
  const bar = (i, o, h, l, c) => ({ time: T0 + i * 300, open: o, high: h, low: l, close: c, volume: 1000 });
  return ctx({
    ltp: 103.6,
    atr5: 0.5,
    prevClose: 100,
    gapPct: 2.5,
    tick: { open: 102.5 },
    today5: [bar(0, 102.5, 103, 102.3, 102.9), bar(1, 102.9, 103.4, 102.8, 103.3), bar(2, 103.3, 103.4, 103.3, 103.4)],
    levels: [],
    news: { label: 'BULLISH', title: 'Wins a large order', reaction: 'AGREES', movePct: 1 },
    ...over,
  });
};

test('a held gap on agreeing news that breaks the first bars\' high is a News gap, marked early', () => {
  const [c] = newsGap(gapCtx());
  assert.equal(c.setup, 'News gap');
  assert.equal(c.side, 'BUY');
  assert.equal(c.early, true);
  assert.equal(c.status, 'ENTRY');
  assert.ok(c.stopLoss < 102.3, 'the stop is below where the gap held');
  assert.match(c.reasons[0], /opened up 2.5% on news/);
});

test('no News gap without agreeing news, a big enough gap, a held gap, or when the news is being sold', () => {
  assert.deepEqual(newsGap(gapCtx({ news: null })), []);
  assert.deepEqual(newsGap(gapCtx({ news: { label: 'BEARISH', title: 'x', reaction: 'AGREES' } })).filter((c) => c.side === 'BUY'), []);
  assert.deepEqual(newsGap(gapCtx({ news: { label: 'BULLISH', title: 'x', reaction: 'FADING' } })), []);
  assert.deepEqual(newsGap(gapCtx({ gapPct: 1 })), []);
  const bar = (i, o, h, l, c) => ({ time: T0 + i * 300, open: o, high: h, low: l, close: c, volume: 1000 });
  assert.deepEqual(newsGap(gapCtx({ today5: [bar(0, 102.5, 103, 100.4, 102.9), bar(1, 102.9, 103.4, 102.8, 103.3), bar(2, 103.3, 103.4, 103.3, 103.4)] })), [], 'gave back more than half of the gap');
});

test('before 09:20 nothing; 09:20 to 09:30 only the news-gap setup; then everything until 15:15', () => {
  const at = (h, m) => new Date(Date.UTC(2026, 9, 27, h, m) - 5.5 * 3600000); // IST
  assert.equal(entryWindow(at(9, 19)), 'closed');
  assert.equal(entryWindow(at(9, 20)), 'early');
  assert.equal(entryWindow(at(9, 29)), 'early');
  assert.equal(entryWindow(at(9, 30)), 'open');
  assert.equal(entryWindow(at(14, 59)), 'open');
  assert.equal(entryWindow(at(15, 14)), 'open');
  assert.equal(entryWindow(at(15, 15)), 'closed');
  assert.equal(entryWindow(at(9, 25), true), 'closed', 'the old rules keep their 09:30 start');
});
