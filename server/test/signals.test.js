import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { analyze, positionAdvice } from '../src/signals/analyze.js';
import { swings, sessionVwap, atr } from '../src/signals/indicators.js';
import { Signal } from '../src/models/index.js';
import { setup, teardown, closeDb, registerUser, settle } from './helpers.js';

// 2026-10-22 09:15 IST in UTC seconds.
const T0 = Date.UTC(2026, 9, 22, 3, 45) / 1000;

/** Bars that follow `path(i)` with a small zig-zag so swings and RSI behave like a real chart. */
function bars(n, path, { step = 300, volume = () => 10000 } = {}) {
  const out = [];
  let prev = path(0);
  for (let i = 0; i < n; i++) {
    const close = path(i) + [-2.2, 1.6, -0.8, 1.4][i % 4];
    const open = prev;
    out.push({ time: T0 + i * step, open, high: Math.max(open, close) + 0.4, low: Math.min(open, close) - 0.4, close, volume: volume(i) });
    prev = close;
  }
  return out;
}

const tickFor = (c, extra = {}) => ({
  ltp: c.at(-1).close,
  open: c[0].open,
  high: Math.max(...c.map((b) => b.high)),
  low: Math.min(...c.map((b) => b.low)),
  prevClose: c[0].open,
  totalBuyQty: 7000,
  totalSellQty: 3000,
  ...extra,
});

function sample(direction) {
  // A trend with a pullback halfway so there is a swing level behind price and room in front.
  const path = (i) => 1000 + direction * (i < 40 ? i * 1.2 : i < 50 ? 48 - (i - 40) * 1.5 : 33 + (i - 50) * 1.3);
  const c5 = bars(66, path);
  const c15 = bars(22, (i) => path(i * 3), { step: 900 });
  return { c5, c15, tick: tickFor(c5) };
}

test('indicators: swings, VWAP and ATR', () => {
  const c = [10, 11, 12, 13, 12, 11, 10, 11, 12].map((p, i) => ({ time: T0 + i * 300, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 100 }));
  const { highs, lows } = swings(c, 2);
  assert.equal(highs.length, 1);
  assert.equal(lows.length, 1);
  assert.ok(Math.abs(sessionVwap(c) - 11.2) < 1);
  assert.ok(atr(bars(20, (i) => 100 + i)) > 0);
});

test('a steady uptrend gives BUY with a plan that is worth the risk', () => {
  const { c5, c15, tick } = sample(1);
  const s = analyze({ symbol: 'TCS', tick: { ...tick, ltp: c5.at(-1).close }, c5, c15, niftyChangePct: 0.6 });
  assert.equal(s.action, 'BUY');
  assert.ok(s.plan.stopLoss < s.ltp && s.plan.target > s.ltp);
  assert.ok(s.plan.riskReward >= 1.5);
  assert.match(s.plan.stopReason, /VWAP/);
  assert.ok(s.invalidation.length > 0);
});

test('a downtrend breaking the day low gives a mirrored SELL plan', () => {
  const { c5, c15, tick } = sample(-1);
  const s = analyze({ symbol: 'TCS', tick: { ...tick, low: tick.ltp, totalBuyQty: 3000, totalSellQty: 7000 }, c5, c15, niftyChangePct: -0.6 });
  assert.equal(s.action, 'SELL');
  assert.ok(s.plan.stopLoss > s.ltp && s.plan.target < s.ltp);
});

test('a downtrend just above the day low is refused: too little room to fall', () => {
  const { c5, c15, tick } = sample(-1);
  const s = analyze({ symbol: 'TCS', tick: { ...tick, totalBuyQty: 3000, totalSellQty: 7000 }, c5, c15, niftyChangePct: -0.6 });
  assert.equal(s.action, 'NO_TRADE');
  assert.match(s.headline, /too close/);
});

test('a sideways market gives NO_TRADE without a plan', () => {
  const c5 = bars(66, () => 1000);
  const c15 = bars(22, () => 1000, { step: 900 });
  const s = analyze({ symbol: 'TCS', tick: tickFor(c5, { totalBuyQty: 5000, totalSellQty: 5000 }), c5, c15, niftyChangePct: 0 });
  assert.equal(s.action, 'NO_TRADE');
  assert.equal(s.plan, null);
});

test('too little history gives NO_TRADE', () => {
  const c5 = bars(10, (i) => 1000 + i);
  assert.equal(analyze({ symbol: 'TCS', tick: tickFor(c5), c5, c15: [] }).action, 'NO_TRADE');
});

test('BUY is refused when the market and momentum disagree with the trend', () => {
  const { c5, c15, tick } = sample(1);
  const s = analyze({ symbol: 'TCS', tick: { ...tick, ltp: tick.ltp - 30 }, c5, c15, niftyChangePct: -1 });
  assert.equal(s.action, 'NO_TRADE');
  assert.equal(s.plan, null);
});

test('position advice says HOLD with the trend and EXIT against it', () => {
  assert.equal(positionAdvice({ action: 'BUY', score: 5 }, 10).advice, 'HOLD');
  assert.equal(positionAdvice({ action: 'SELL', score: -5 }, 10).advice, 'CONSIDER_EXIT');
  assert.equal(positionAdvice({ action: 'NO_TRADE', score: 4 }, -10).advice, 'CONSIDER_EXIT');
  assert.equal(positionAdvice({ action: 'NO_TRADE', score: 0 }, 0), null);
});

let ctx;
after(async () => {
  await teardown(ctx);
  await closeDb();
});

test('GET /api/signals/:symbol works on the mock feed and needs auth', async () => {
  ctx = await setup();
  const { auth } = await registerUser(ctx.app);
  await request(ctx.app).get('/api/signals/TCS').expect(401);
  ctx.provider.setPrice('TCS', ctx.provider.getLastTick('TCS').ltp);
  await request(ctx.app).get('/api/signals/NOPE').set(auth).expect(404);
  const res = await request(ctx.app).get('/api/signals/TCS').set(auth).expect(200);
  assert.ok(['BUY', 'SELL', 'NO_TRADE'].includes(res.body.action));
  assert.ok(res.body.factors.length >= 5);
  assert.match(res.body.disclaimer, /Not investment advice/);
  const stats = await request(ctx.app).get('/api/signals/stats').set(auth).expect(200);
  assert.equal(stats.body.total, res.body.plan ? 1 : 0);
});

test('tracker closes a signal at target, logs once, and reports hit rate', async () => {
  const { user, auth } = await registerUser(ctx.app);
  const ltp = ctx.provider.getLastTick('INFY').ltp;
  const sig = { symbol: 'INFY', action: 'BUY', ltp, score: 5, plan: { stopLoss: ltp - 10, target: ltp + 20, riskReward: 2 } };
  await ctx.tracker.record(user.id, sig);
  await ctx.tracker.record(user.id, sig);
  assert.equal(await Signal.countDocuments({ user: user.id }), 1);
  ctx.provider.setPrice('INFY', ltp + 25);
  await settle();
  const doc = await Signal.findOne({ user: user.id }).lean();
  assert.equal(doc.status, 'TARGET_HIT');
  const stats = await request(ctx.app).get('/api/signals/stats').set(auth).expect(200);
  assert.equal(stats.body.wins, 1);
  assert.equal(stats.body.hitRate, 100);
});
