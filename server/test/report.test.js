import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { AutoLog, ScanIdea } from '../src/models/index.js';
import { buildDayReport } from '../src/report/dayReport.js';
import { setup, teardown, closeDb, registerUser } from './helpers.js';

let ctx;
let app;
let user;
before(async () => {
  ctx = await setup();
  app = createApp(ctx);
  user = await registerUser(app);
});
after(async () => {
  await teardown(ctx);
  await closeDb();
});

test('the day report is one text block with the rules, ideas, trades, skips and no secrets', async () => {
  const day = ctx.engine.marketStatus().istDate;
  const uid = user.user.id || user.user._id;
  await ScanIdea.create({ day, symbol: 'SBIN', setup: 'ORB', side: 'BUY', entry: 800, stopLoss: 796, target1: 806, target2: 810, riskReward: 1.5, score: 82, status: 'STOPPED', exitPrice: 796, bestR: 0.3, worstR: -1 });
  await AutoLog.create({ user: uid, day, symbol: 'SBIN', side: 'BUY', setup: 'ORB', score: 82, decision: 'PLACED', status: 'CLOSED', entry: 800, stopLoss: 796, fillPrice: 800.1, qty: 100, outcome: { exitReason: 'STOP', exitPrice: 796, grossPnl: -410, charges: 40, netPnl: -450, resultR: -1.02, minutesHeld: 22, bestR: 0.3, worstR: -1 } });
  await AutoLog.create({ user: uid, day, symbol: 'ITC', side: 'BUY', decision: 'SKIPPED', status: 'SKIPPED', reason: 'score 65 is below 70', setup: 'VWAP', score: 65 });
  await AutoLog.create({ user: uid, day, symbol: 'NIFTY-20261103-25000-CE', segment: 'OPT', side: 'BUY', decision: 'PLACED', status: 'CLOSED', score: 84, fillPrice: 200, stopLoss: 180, detail: { label: 'NIFTY 25000 CE', lots: 2 }, outcome: { exitReason: 'LOCK', exitPrice: 230, grossPnl: 3900, charges: 90, netPnl: 3810, resultR: 1.5, minutesHeld: 55, bestR: 1.8, worstR: -0.2 } });

  const r = await request(app).get('/api/report/day').set(user.auth).expect(200);
  assert.equal(r.body.day, day);
  const t = r.body.text;
  assert.match(t, /# Nifty paper trader: day report for/);
  assert.match(t, /## Rules in force/);
  assert.match(t, /Auto shares: .*stop ₹200 a trade; once the profit reaches ₹250 the stop follows ₹80 behind the best profit/);
  assert.match(t, /Auto options: .*loss limit ₹1500 a trade; once the profit reaches ₹1000 the stop follows ₹250 behind the best profit/);
  assert.match(t, /SBIN BUY ORB score 82: entry 800, SL 796, T1 806 -> STOPPED at 796 \(-1R\)/);
  assert.match(t, /## Auto share trades \(1 placed, 1 closed: 0 won, 1 lost, net -₹450/);
  assert.match(t, /SBIN BUY qty 100 ORB score 82: bought at 800\.1, stop 796 -> STOP at 796, net -₹450/);
  assert.match(t, /Skipped 1: 1x score 65 is below 70/);
  assert.match(t, /NIFTY 25000 CE, 2 lot .*-> LOCK at 230, net ₹3,810/);
  assert.doesNotMatch(t, /secret|token|password|JWT/i);
  await request(app).get('/api/report/day?day=nonsense').set(user.auth).expect(400);
  await request(app).get('/api/report/day').expect(401);
});

test('an empty day still gives a readable report', () => {
  const t = buildDayReport({ day: '2026-10-26', generatedAt: new Date(), market: { provider: 'mock', simulated: true } });
  assert.match(t, /SIMULATED/);
  assert.match(t, /None raised\./);
  assert.match(t, /No trades placed\./);
});
