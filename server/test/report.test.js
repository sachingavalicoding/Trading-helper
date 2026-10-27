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
  assert.match(t, /lock ladder \(% of money\): \+0\.3% keeps 0\.15%/);
  assert.match(t, /lock ladder \(₹ per lot\): \+700 keeps 400/);
  assert.match(t, /SBIN BUY ORB score 82: entry 800, SL 796, T1 806 -> STOPPED at 796 \(-1R\)/);
  assert.match(t, /## Auto share trades \(1 placed, 1 closed: 0 won, 1 lost, net -₹450/);
  assert.match(t, /SBIN BUY qty 100 ORB score 82: bought at 800\.1, stop 796 -> STOP at 796, net -₹450/);
  assert.match(t, /Skipped 1: 1x score 65 is below 70/);
  assert.match(t, /NIFTY 25000 CE, 2 lot .*-> LOCK at 230, net ₹3,810/);
  assert.match(t, /risk ₹200 a trade/);
  assert.doesNotMatch(t, /secret|token|password|JWT/i);
  await request(app).get('/api/report/day?day=nonsense').set(user.auth).expect(400);
  await request(app).get('/api/report/day').expect(401);
});

test('hand sales and rows stamped while the market is shut are labelled, and options split auto from by hand', () => {
  const t = buildDayReport({
    day: '2026-10-27',
    generatedAt: new Date(),
    settings: { auto: { enabled: true, minScore: 70, maxOpen: 3, dailyLossPct: 2, maxTradeAmount: 30000, lockLadder: [{ at: 0.3, keep: 0.15 }] } },
    eqLog: [{ decision: 'PLACED', status: 'CLOSED', symbol: 'ITC', side: 'BUY', setup: 'ORB', score: 80, qty: 10, fillPrice: 400, entry: 400, stopLoss: 396, decidedAt: new Date('2026-10-27T04:10:00Z'), outcome: { exitReason: 'MANUAL', exitPrice: 404, grossPnl: 40, charges: 10, netPnl: 30, resultR: 1, minutesHeld: 30 } }],
    optLog: [
      { decision: 'PLACED', status: 'CLOSED', symbol: 'NIFTY-X', side: 'BUY', score: 80, fillPrice: 200, stopLoss: 180, decidedAt: new Date('2026-10-27T04:30:00Z'), detail: { label: 'NIFTY 25000 CE', lots: 1 }, outcome: { exitReason: 'LOCK', exitPrice: 230, grossPnl: 1950, charges: 80, netPnl: 1870, resultR: 1.5, minutesHeld: 40 } },
      { decision: 'PLACED', status: 'CLOSED', symbol: 'NIFTY-Y', side: 'BUY', score: 60, fillPrice: 200, stopLoss: 180, decidedAt: new Date('2026-10-27T16:10:00Z'), detail: { label: 'NIFTY 25000 CE', lots: 1, manual: true }, outcome: { exitReason: 'TIME', exitPrice: 199, grossPnl: -65, charges: 80, netPnl: -145, resultR: 0, minutesHeld: 0 } },
    ],
  });
  assert.match(t, /risk ₹200 \(default\) a trade/, 'a settings row without a risk amount shows the default the trader uses');
  assert.match(t, /MANUAL \(sold by hand\) at 404/);
  assert.match(t, /Exits: MANUAL \(sold by hand\) 1/);
  assert.match(t, /21:40 \[market shut\] NIFTY 25000 CE \(by hand\)/);
  assert.doesNotMatch(t, /09:40 \[market shut\]/);
  assert.match(t, /Auto: 1 trades, net ₹1,870\. By hand: 1 trades, net -₹145\./);
});

test('an empty day still gives a readable report', () => {
  const t = buildDayReport({ day: '2026-10-26', generatedAt: new Date(), market: { provider: 'mock', simulated: true } });
  assert.match(t, /SIMULATED/);
  assert.match(t, /None raised\./);
  assert.match(t, /No trades placed\./);
});
