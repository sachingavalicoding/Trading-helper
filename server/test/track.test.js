import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { summarizeIdeas, resultR } from '../src/scanner/stats.js';
import { replayStock } from '../src/scanner/replay.js';
import { ScanIdea } from '../src/models/index.js';
import { setup, teardown, closeDb, registerUser } from './helpers.js';

after(closeDb);

const idea = (o) => ({ setup: 'VWAP pullback', side: 'BUY', status: 'TARGET_HIT', entry: 100, stopLoss: 98, exitPrice: 104, score: 75, openedAt: '2026-10-22T04:40:00Z', ...o }); // 10:10 IST

test('result in R: target 1 at 2R, a stop at -1R, shorts mirror', () => {
  assert.equal(resultR(idea({})), 2);
  assert.equal(resultR(idea({ status: 'STOPPED', exitPrice: 98 })), -1);
  assert.equal(resultR(idea({ side: 'SELL', entry: 100, stopLoss: 102, exitPrice: 96 })), 2);
  assert.equal(resultR(idea({ exitPrice: undefined })), null);
});

test('track record groups by setup, side, hour and score, and skips open ideas', () => {
  const s = summarizeIdeas([
    idea({}),
    idea({ status: 'STOPPED', exitPrice: 98 }),
    idea({ setup: 'Opening range breakout', side: 'SELL', entry: 100, stopLoss: 102, exitPrice: 96, openedAt: '2026-10-22T04:10:00Z', score: 85 }), // 09:40 IST
    idea({ status: 'EXPIRED', exitPrice: 100.5 }),
    idea({ status: 'OPEN', exitPrice: undefined }),
  ]);
  assert.equal(s.overall.count, 4);
  assert.deepEqual([s.overall.wins, s.overall.stops, s.overall.expired], [2, 1, 1]);
  assert.equal(s.overall.winRate, 50);
  assert.equal(s.overall.avgR, 0.81); // (2 - 1 + 2 + 0.25) / 4 = 0.8125
  assert.equal(s.overall.enough, false);
  const vwap = s.bySetup.find((r) => r.key === 'VWAP pullback');
  assert.equal(vwap.count, 3);
  assert.equal(s.bySide.find((r) => r.key === 'SELL').count, 1);
  assert.deepEqual(s.byHour.map((r) => r.label), ['09:00', '10:00']);
  assert.deepEqual(s.byScore.map((r) => r.key), ['80+', '70-79']);
});

// --- replay on synthetic candles ---
const DAY = 86400;
const T0 = Date.UTC(2026, 9, 21, 3, 45) / 1000;
const T1 = T0 + DAY;
function session(start, n, close, vol = () => 1000) {
  const out = [];
  let prev = close(0);
  for (let i = 0; i < n; i++) {
    const c = close(i);
    out.push({ time: start + i * 60, open: prev, high: Math.max(prev, c) + 0.2, low: Math.min(prev, c) - 0.2, close: c, volume: vol(i) });
    prev = c;
  }
  return out;
}
const prior = session(T0, 375, (i) => 1000 + (i % 2 ? 1 : -1));
const or = session(T1, 15, (i) => 1004 + 3.8 * Math.sin(i * 0.9), () => 1000);
const orHigh = Math.max(...or.map((b) => b.high));
const breakout = [...or, ...session(T1 + 900, 15, (i) => orHigh - 2 + (3 * (i + 1)) / 15, () => 3000), ...session(T1 + 1800, 3, () => orHigh + 0.6, () => 3000)];
const after_ = (close) => session(T1 + 33 * 60, 60, (i) => close(i));

test('replay: an opening range breakout that keeps going ends at target 1', () => {
  const c1 = [...prior, ...breakout, ...after_((i) => orHigh + 0.6 + i * 0.8)];
  const ideas = replayStock({ symbol: 'X', c1, days: 1 });
  const orb = ideas.find((i) => i.setup === 'Opening range breakout' && i.side === 'BUY');
  assert.ok(orb, `expected an ORB idea, got ${JSON.stringify(ideas.map((i) => i.setup))}`);
  assert.equal(orb.status, 'TARGET_HIT');
  assert.equal(orb.exitPrice, orb.target1);
  assert.equal(ideas.filter((i) => i.setup === orb.setup && i.side === orb.side).length, 1); // once per day
});

test('replay: the same breakout that fails is stopped out', () => {
  const c1 = [...prior, ...breakout, ...after_((i) => orHigh + 0.6 - i * 0.8)];
  const orb = replayStock({ symbol: 'X', c1, days: 1 }).find((i) => i.setup === 'Opening range breakout' && i.side === 'BUY');
  assert.ok(orb);
  assert.equal(orb.status, 'STOPPED');
  assert.equal(orb.exitPrice, orb.stopLoss);
});

test('replay: only the requested sessions are replayed, and nothing is raised with too little history', () => {
  assert.deepEqual(replayStock({ symbol: 'X', c1: prior, days: 1 }), []);
  const c1 = [...prior, ...breakout, ...after_((i) => orHigh + 0.6 + i * 0.8)];
  assert.ok(replayStock({ symbol: 'X', c1, days: 1 }).every((i) => i.openedAt >= new Date(T1 * 1000).toISOString()));
});

test('stats route reports finished ideas only', async () => {
  const ctx = await setup();
  const { auth } = await registerUser(ctx.app);
  const base = { day: '2026-10-22', symbol: 'SBIN', side: 'BUY', entry: 800, stopLoss: 790, target1: 820, target2: 830, riskReward: 2, score: 78 };
  await ScanIdea.create({ ...base, setup: 'VWAP pullback', status: 'TARGET_HIT', exitPrice: 820 });
  await ScanIdea.create({ ...base, symbol: 'TCS', setup: 'VWAP pullback', status: 'STOPPED', exitPrice: 790 });
  await ScanIdea.create({ ...base, symbol: 'ITC', setup: 'Level retest', status: 'OPEN' });
  const res = await request(ctx.app).get('/api/scanner/stats').set(auth).expect(200);
  assert.equal(res.body.overall.count, 2);
  assert.equal(res.body.overall.avgR, 0.5); // +2R and -1R
  assert.equal(res.body.bySetup.length, 1);
  assert.match(res.body.disclaimer, /Not investment advice/);
  await request(ctx.app).get('/api/scanner/stats').expect(401);
  await teardown(ctx);
});

test('stopped ideas report how often they were in profit first, and how long they lasted', async () => {
  const { summarizeIdeas } = await import('../src/scanner/stats.js');
  const base = { setup: 'X', side: 'BUY', entry: 100, stopLoss: 99, exitPrice: 99, status: 'STOPPED', score: 80, openedAt: '2026-10-26T04:00:00Z' };
  const s = summarizeIdeas([
    { ...base, bestR: 0.8, closedAt: '2026-10-26T04:10:00Z' },
    { ...base, bestR: 0.1, closedAt: '2026-10-26T04:20:00Z' },
    { ...base, bestR: 1.2, closedAt: '2026-10-26T04:30:00Z' },
    { ...base, bestR: undefined, closedAt: '2026-10-26T04:05:00Z' }, // recorded before tracking began
  ]).stopped;
  assert.equal(s.count, 3);
  assert.equal(s.reachedHalfR, 67);
  assert.equal(s.reachedOneR, 33);
  assert.equal(s.medianMinutes, 20);
});
