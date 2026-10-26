import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDaily } from '../src/scanner/daily.js';
import { adx } from '../src/signals/indicators.js';
import { scoreCandidate, WEIGHTS, LEGACY_WEIGHTS, MIN_ADX } from '../src/scanner/evaluate.js';

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

const ctx = (over = {}) => ({ ltp: 101, vwap: 100, trend5: 1, trend15: 1, relVol: 2, relStrength: 0.6, bookShare: 0.7, rsi: 60, macdHist: { now: 1, prev: 0.5 }, niftyChangePct: 0.3, vwapStretch: 0.5, news: null, adx: 30, emaStack: 1, sectorStrength: 0.4, month: { trend: 1, sessions: 22 }, ...over });
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
