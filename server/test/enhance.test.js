import { test } from 'node:test';
import assert from 'node:assert/strict';
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

const ctx = (over = {}) => ({ ltp: 101, vwap: 100, trend5: 1, trend15: 1, relVol: 2, relStrength: 0.6, bookShare: 0.7, rsi: 60, macdHist: { now: 1, prev: 0.5 }, niftyChangePct: 0.3, vwapStretch: 0.5, news: null, adx: 30, emaStack: 1, sectorStrength: 0.4, ...over });
const cand = (over = {}) => ({ side: 'BUY', status: 'ENTRY', entry: 101, stopLoss: 100.4, setup: 'X', ...over });

test('a clean trend, aligned EMAs and a backing sector earn full marks', () => {
  const r = scoreCandidate(ctx(), cand());
  assert.equal(r.score, 100);
  for (const id of ['adx', 'emaStack', 'sector']) assert.equal(r.checks.find((c) => c.id === id).points, WEIGHTS[id === 'emaStack' ? 'emaStack' : id]);
});

test('a sideways stock is blocked by the ADX gate and loses the trend points', () => {
  const r = scoreCandidate(ctx({ adx: 10 }), cand());
  assert.ok(r.blocked.some((t) => /sideways/.test(t)));
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

test('legacy scoring has no ADX gate and none of the new checks', () => {
  const r = scoreCandidate(ctx({ adx: 5 }), cand(), { legacy: true });
  assert.ok(!r.blocked.length);
  assert.ok(!r.checks.some((c) => ['adx', 'emaStack', 'sector'].includes(c.id)));
});

test('a stock that already ran far in the trade direction is blocked as chasing, in either direction', () => {
  const buy = scoreCandidate(ctx({ changePct: 7 }), cand());
  assert.ok(buy.blocked.some((t) => /chasing/.test(t)));
  const sell = scoreCandidate(ctx({ changePct: -7, ltp: 99, trend5: -1, trend15: -1 }), cand({ side: 'SELL' }));
  assert.ok(sell.blocked.some((t) => /chasing/.test(t)));
  assert.ok(!scoreCandidate(ctx({ changePct: 2 }), cand()).blocked.length);
  assert.ok(!scoreCandidate(ctx({ changePct: -7 }), cand()).blocked.some((t) => /chasing/.test(t))); // a BUY after a fall is not chasing
  assert.ok(!scoreCandidate(ctx({ changePct: 7 }), cand(), { legacy: true }).blocked.length);
});
