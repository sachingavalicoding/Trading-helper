import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser, settle } from './helpers.js';
import { createApp } from '../src/app.js';
import { AutoTrader } from '../src/auto/autoTrader.js';
import { AutoLog, AutoSettings, Order, Position } from '../src/models/index.js';
import { summarizeLog } from '../src/auto/logSummary.js';

let ctx;
let app;
let trader;
let user;

before(async () => {
  ctx = await setup();
  trader = new AutoTrader({ scanner: ctx.scanner, engine: ctx.engine, config: ctx.config });
  app = createApp({ ...ctx, autoTrader: trader });
  user = await registerUser(app);
  for (const [sym, px] of [['TCS', 3000], ['INFY', 1500], ['SBIN', 800], ['HDFCBANK', 1600], ['ITC', 400], ['LT', 3500]]) ctx.provider.setPrice(sym, px);
  await settle();
});
after(async () => {
  await teardown(ctx);
  await closeDb();
});

const idea = (symbol, side = 'BUY', score = 80) => {
  const ltp = ctx.provider.getLastTick(symbol).ltp;
  return {
    _id: `${symbol}-${side}-${score}-${Math.random()}`,
    symbol,
    side,
    score,
    entry: ltp,
    stopLoss: side === 'BUY' ? ltp - ltp * 0.005 : ltp + ltp * 0.005,
    target1: side === 'BUY' ? ltp + ltp * 0.01 : ltp - ltp * 0.01,
    target2: side === 'BUY' ? ltp + ltp * 0.02 : ltp - ltp * 0.02,
  };
};
const settings = (over = {}) => ({ user: user.user.id || user.user._id, enabled: true, minScore: 70, maxOpen: 3, riskPct: 1, dailyLossPct: 3, ...over });

test('auto trading is off by default and can be switched on', async () => {
  const off = await request(app).get('/api/auto').set(user.auth).expect(200);
  assert.equal(off.body.settings.enabled, false);
  assert.match(off.body.disclaimer, /paper/i);
  const on = await request(app).put('/api/auto').set(user.auth).send({ enabled: true, minScore: 75 }).expect(200);
  assert.equal(on.body.settings.enabled, true);
  assert.equal(on.body.settings.minScore, 75);
  await request(app).put('/api/auto').set(user.auth).send({ minScore: 10 }).expect(400);
  await request(app).put('/api/auto').set(user.auth).send({ enabled: false }).expect(200);
});

test('places a tagged paper order with its stop and target, and skips weak ideas', async () => {
  const s = settings();
  const weak = await trader.consider(s, idea('TCS', 'BUY', 65));
  assert.match(weak.skipped, /below/);

  const r = await trader.consider(s, idea('TCS', 'BUY'));
  assert.equal(r.order.status, 'FILLED');
  assert.equal(r.order.source, 'AUTO');
  const legs = await Order.find({ symbol: 'TCS', role: { $in: ['STOPLOSS', 'TARGET'] } }).lean();
  assert.equal(legs.length, 2);
  assert.ok(legs.every((l) => l.source === 'AUTO'));
  assert.equal((await trader.todaySummary(s.user)).open, 1);
});

test('will not double up in a stock it already holds, and respects the open-trade cap', async () => {
  const s = settings({ maxOpen: 2 });
  const again = await trader.consider(s, idea('TCS', 'BUY'));
  assert.match(again.skipped, /already in this stock/);
  const second = await trader.consider(s, idea('INFY', 'SELL'));
  assert.equal(second.order.side, 'SELL');
  const third = await trader.consider(s, idea('SBIN', 'BUY'));
  assert.match(third.skipped, /auto trades open/);
});

test('stops opening trades once the daily loss limit is hit', async () => {
  const s = settings({ maxOpen: 10, dailyLossPct: 0.5 });
  const tcs = ctx.provider.getLastTick('TCS').ltp;
  ctx.provider.setPrice('TCS', tcs * 0.9); // far below the stop: the stop-loss leg fills
  await settle();
  assert.equal(await Position.countDocuments({ symbol: 'TCS', status: 'OPEN' }), 0);
  const r = await trader.consider(s, idea('HDFCBANK', 'BUY'));
  assert.match(r.skipped, /daily loss limit/);
});

test('the order API cannot set the AUTO tag', async () => {
  const res = await request(app).post('/api/orders').set(user.auth).send({ symbol: 'ITC', side: 'BUY', qty: 1, source: 'AUTO' }).expect(201);
  assert.equal(res.body.order.source, 'MANUAL');
});

test('does nothing for users who left it off', async () => {
  const other = await registerUser(app);
  await AutoSettings.create({ user: other.user.id || other.user._id, enabled: false });
  await trader.handle(idea('LT', 'BUY'));
  assert.equal(await Order.countDocuments({ symbol: 'LT' }), 0);
});

test('skips an idea whose price has already run away from the entry', async () => {
  const s = settings({ maxOpen: 10 });
  const late = idea('ITC', 'BUY');
  late.entry = ctx.provider.getLastTick('ITC').ltp - 3; // price is already well above the entry
  late.stopLoss = late.entry - 2;
  const r = await trader.consider(s, late);
  assert.match(r.skipped, /already moved/);
});

test('never puts more than the max amount into one trade', async () => {
  const fresh = await registerUser(app);
  const s = settings({ user: fresh.user.id || fresh.user._id, maxOpen: 10, maxTradeAmount: 5000, riskPct: 3 });
  const r = await trader.consider(s, idea('LT', 'BUY'));
  assert.ok(r.order, r.skipped);
  assert.ok(r.order.qty * r.order.ltpAtPlacement <= 5000);
});

test('shares are sized from the risk and max amount unless a cap is set', async () => {
  const free = await registerUser(app);
  const r1 = await trader.consider(settings({ user: free.user.id || free.user._id, maxOpen: 10 }), idea('LT', 'BUY'));
  assert.ok(r1.order, r1.skipped);
  assert.ok(r1.order.qty > 1);
  const capped = await registerUser(app);
  const r2 = await trader.consider(settings({ user: capped.user.id || capped.user._id, maxOpen: 10, maxShares: 1 }), idea('LT', 'BUY'));
  assert.ok(r2.order, r2.skipped);
  assert.equal(r2.order.qty, 1);
});

test('past each target an auto trade is not sold: the stop jumps to just short of it, and the sale is at a third target', async () => {
  const fresh = await registerUser(app);
  const s = settings({ user: fresh.user.id || fresh.user._id, maxOpen: 10, maxShares: 1, lockByRisk: false }); // the ladder would lift the stop too; this checks the target steps alone
  ctx.provider.setPrice('ONGC', 250);
  const i = idea('ONGC', 'BUY');
  const r = await trader.consider(s, i);
  assert.ok(r.order, r.skipped);
  const target = await Order.findOne({ user: s.user, symbol: 'ONGC', role: 'TARGET', status: 'OPEN' }).lean();
  assert.ok(Math.abs(target.price - (i.target2 * 2 - i.target1)) <= 0.06, 'sells at a third target, not 1 or 2');
  const stopAt = async () => (await Order.findOne({ user: s.user, symbol: 'ONGC', role: 'STOPLOSS', status: 'OPEN' }).lean()).triggerPrice;
  ctx.provider.setPrice('ONGC', i.target1 + 0.5);
  await settle();
  assert.ok(Math.abs((await stopAt()) - (i.entry + 0.8 * (i.target1 - i.entry))) <= 0.06, 'stop just short of target 1');
  ctx.provider.setPrice('ONGC', i.target2 + 0.5);
  await settle();
  assert.ok(Math.abs((await stopAt()) - (i.entry + 0.8 * (i.target2 - i.entry))) <= 0.06, 'stop just short of target 2');
  assert.equal((await Position.findOne({ user: s.user, symbol: 'ONGC' })).status, 'OPEN');
});

test('the auto log records every decision, placed or skipped, with the numbers behind it', async () => {
  const fresh = await registerUser(app);
  const s = settings({ user: fresh.user.id || fresh.user._id, maxOpen: 10, maxShares: 1 });
  await trader.consider(s, idea('SBIN', 'BUY', 60));
  const i = idea('SBIN', 'BUY', 85);
  i.setup = 'ORB';
  i.card = { checks: [{ key: 'vwap', points: 4 }] };
  const r = await trader.consider(s, i);
  assert.ok(r.order, r.skipped);
  const rows = await AutoLog.find({ user: s.user }).sort({ decidedAt: 1 }).lean();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].decision, 'SKIPPED');
  assert.match(rows[0].reason, /below/);
  assert.equal(rows[1].decision, 'PLACED');
  assert.equal(rows[1].status, 'OPEN');
  assert.equal(rows[1].setup, 'ORB');
  assert.equal(rows[1].qty, 1);
  assert.equal(String(rows[1].order), String(r.order._id));
  assert.equal(rows[1].card.checks[0].key, 'vwap');
  assert.ok(rows[1].ltp > 0 && rows[1].position);

  const res = await request(app).get('/api/auto/log').set(fresh.auth).expect(200);
  assert.equal(res.body.summary.placed, 1);
  assert.equal(res.body.summary.skipped, 1);
  assert.equal(res.body.entries[0].checks, undefined);
  assert.equal(res.body.entries[1].checks[0].key, 'vwap');
  await request(app).get('/api/auto/log?day=nope').set(fresh.auth).expect(400);
});

test('the log fills in how a trade ended: stop, profit lock, target, manual exit', async () => {
  trader.start();
  try {
    const fresh = await registerUser(app);
    const uid = fresh.user.id || fresh.user._id;
    const s = settings({ user: uid, maxOpen: 10, maxShares: 1 });
    const outcomeOf = async (symbol) => (await AutoLog.findOne({ user: uid, symbol, decision: 'PLACED' }).lean());

    // stopped out at a loss
    ctx.provider.setPrice('INFY', 1500);
    await settle();
    const a = idea('INFY', 'BUY');
    await trader.consider(s, a);
    ctx.provider.setPrice('INFY', a.entry + 2); // best R > 0
    await settle();
    ctx.provider.setPrice('INFY', a.stopLoss - 1);
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    let row = await outcomeOf('INFY');
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.outcome.exitReason, 'STOP');
    assert.ok(row.outcome.netPnl < 0);
    assert.ok(row.outcome.resultR < 0);
    assert.ok(row.outcome.bestR > 0 && row.outcome.worstR < 0);
    assert.equal(row.outcome.netPnl, Math.round((row.outcome.grossPnl - row.outcome.charges) * 100) / 100);

    // a manual exit
    ctx.provider.setPrice('ITC', 400);
    await settle();
    const b = idea('ITC', 'SELL');
    await trader.consider(s, b);
    await request(app).post('/api/positions/ITC/exit').set(fresh.auth).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    row = await outcomeOf('ITC');
    assert.equal(row.outcome.exitReason, 'MANUAL');

    // the stop jumps past target 1, then price falls back and the raised stop is hit: a lock
    ctx.provider.setPrice('SBIN', 800);
    await settle();
    const c = idea('SBIN', 'BUY');
    await trader.consider(s, c);
    ctx.provider.setPrice('SBIN', c.target1 + 0.5);
    await settle();
    ctx.provider.setPrice('SBIN', c.entry + 0.75 * (c.target1 - c.entry));
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    row = await outcomeOf('SBIN');
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.outcome.exitReason, 'LOCK');
    assert.ok(row.outcome.netPnl !== undefined && row.outcome.grossPnl > 0);
  } finally {
    trader.stop();
  }
});

test('the day summary adds up exits and setups, groups skip reasons, and checks skips in hindsight', () => {
  const closed = (setup, exitReason, netPnl, extra = {}) => ({ decision: 'PLACED', status: 'CLOSED', setup, score: 82, outcome: { exitReason, netPnl, grossPnl: netPnl + 10, charges: 10, resultR: netPnl > 0 ? 1 : -1, minutesHeld: 30, ...extra } });
  const skipped = (reason, idea) => ({ decision: 'SKIPPED', status: 'SKIPPED', reason, idea });
  const ideas = new Map([['a', { status: 'TARGET_HIT' }], ['b', { status: 'STOPPED' }]]);
  const sum = summarizeLog(
    [closed('ORB', 'STOP', -100, { bestR: 0.8 }), closed('ORB', 'TARGET', 200), closed('VWAP', 'STOP', -50), { decision: 'PLACED', status: 'OPEN', setup: 'ORB', score: 75 }, skipped('score 62 is below 70', 'a'), skipped('score 65 is below 70', 'b'), skipped('already in this stock')],
    ideas,
  );
  assert.equal(sum.placed, 4);
  assert.equal(sum.closed, 3);
  assert.equal(sum.open, 1);
  assert.equal(sum.netPnl, 50);
  assert.equal(sum.charges, 30);
  assert.equal(sum.gaveBack, 1);
  assert.equal(sum.byExit.find((g) => g.key === 'STOP').trades, 2);
  assert.equal(sum.bySetup.find((g) => g.key === 'ORB').netPnl, 100);
  assert.equal(sum.skipReasons[0].count, 2);
  assert.deepEqual(sum.skippedHindsight, { followed: 2, wouldHitTarget: 1, wouldStop: 1, unresolved: 0 });
});

test('the profit ladder of an auto trade is sized from the money risked, and can be turned off', async () => {
  const a = await registerUser(app);
  const sa = settings({ user: a.user.id || a.user._id, maxOpen: 10 });
  ctx.provider.setPrice('SBIN', 800);
  await settle();
  const i = idea('SBIN', 'BUY');
  const r = await trader.consider(sa, i);
  assert.ok(r.order, r.skipped);
  const pos = await Position.findOne({ user: sa.user, symbol: 'SBIN', status: 'OPEN' }).lean();
  const risk = r.order.qty * Math.abs(i.entry - i.stopLoss);
  assert.deepEqual(pos.lockSteps.map((s) => [s.at, s.keep]), [[1, 0.5], [2.5, 2], [5, 4]].map(([at, keep]) => [Math.round(risk * at * 100) / 100, Math.round(risk * keep * 100) / 100]));

  const b = await registerUser(app);
  const sb = settings({ user: b.user.id || b.user._id, maxOpen: 10, lockByRisk: false });
  ctx.provider.setPrice('ITC', 400);
  await settle();
  const r2 = await trader.consider(sb, idea('ITC', 'BUY'));
  assert.ok(r2.order, r2.skipped);
  const pos2 = await Position.findOne({ user: sb.user, symbol: 'ITC', status: 'OPEN' }).lean();
  assert.equal(pos2.lockTrigger, 1000, 'the fixed rupee default stays');
});

test('skips a trade whose profit at target 1 would not cover its charges three times over', async () => {
  const c = await registerUser(app);
  const s = settings({ user: c.user.id || c.user._id, maxOpen: 10, maxShares: 1 });
  ctx.provider.setPrice('ONGC', 250);
  await settle();
  const tiny = idea('ONGC', 'BUY');
  tiny.target1 = tiny.entry + 0.2; // 20 paise of profit on one share: charges are more than a third of that
  tiny.target2 = tiny.entry + 0.4;
  const r = await trader.consider(s, tiny);
  assert.match(r.skipped, /under 3x the charges/);
  const logged = await AutoLog.findOne({ user: s.user, symbol: 'ONGC' }).lean();
  assert.equal(logged.decision, 'SKIPPED');
});

test('the rupee ladder moves the stop up with the profit: +200 keeps 100, +500 keeps 400, +1,000 keeps 800', async () => {
  const fresh = await registerUser(app);
  const uid = fresh.user.id || fresh.user._id;
  const s = settings({ user: uid, maxOpen: 10, riskAmount: 200, riskPct: 0.1 });
  ctx.provider.setPrice('LT', 3500);
  await settle();
  const i = { ...idea('LT', 'BUY'), stopLoss: 3480, target1: 3600, target2: 3700, target3: 3800 };
  const r = await trader.consider(s, i);
  assert.ok(r.order, r.skipped);
  assert.equal(r.order.qty, 10, '200 / 20 per share');
  const stopAt = async () => (await Order.findOne({ user: uid, symbol: 'LT', role: 'STOPLOSS', status: 'OPEN' }).lean()).triggerPrice;
  assert.equal((await Order.findOne({ user: uid, symbol: 'LT', role: 'TARGET', status: 'OPEN' }).lean()).price, 3800, 'sells at the scanner\'s third target');
  const pos = await Position.findOne({ user: uid, symbol: 'LT', status: 'OPEN' }).lean();
  assert.deepEqual(pos.lockSteps.map((x) => [x.at, x.keep]), [[200, 100], [500, 400], [1000, 800]]);

  ctx.provider.setPrice('LT', 3510); // +100: nothing yet
  await settle();
  assert.equal(await stopAt(), 3480);
  ctx.provider.setPrice('LT', 3521); // +210: keeps about 110 (never below cost + charges)
  await settle();
  const first = await stopAt();
  assert.ok(first > 3510 && first < 3521, `stop ${first}`);
  ctx.provider.setPrice('LT', 3560); // +600: follows 100 behind the best profit, so keeps 500
  await settle();
  assert.ok(Math.abs((await stopAt()) - 3550) <= 0.06, 'stop 10 per share behind');
  ctx.provider.setPrice('LT', 3600); // +1,000: keeps 800
  await settle();
  assert.ok(Math.abs((await stopAt()) - 3580) <= 0.06);
  ctx.provider.setPrice('LT', 3590); // a dip does not lower it
  await settle();
  assert.ok(Math.abs((await stopAt()) - 3580) <= 0.06);
});

test('a trade that has gone nowhere for 45 minutes is closed as a time exit, but a trade that got going is left', async () => {
  trader.start();
  try {
    const fresh = await registerUser(app);
    const uid = fresh.user.id || fresh.user._id;
    const s = settings({ user: uid, maxOpen: 10, maxShares: 1 });
    ctx.provider.setPrice('HDFCBANK', 1600);
    ctx.provider.setPrice('ITC', 400);
    await settle();
    const a = idea('HDFCBANK', 'BUY');
    const b = idea('ITC', 'BUY');
    assert.ok((await trader.consider(s, a)).order);
    assert.ok((await trader.consider(s, b)).order);
    const old = (symbol) => {
      const x = trader.excursion.get(`${uid}|${symbol}`);
      x.openedAt = Date.now() - 50 * 60000;
      return x;
    };
    old('HDFCBANK');
    old('ITC').bestR = 0.8; // this one got going
    ctx.provider.setPrice('HDFCBANK', a.entry - 0.5);
    ctx.provider.setPrice('ITC', b.entry - 0.2);
    await settle();
    await new Promise((r) => setTimeout(r, 100));
    const row = await AutoLog.findOne({ user: uid, symbol: 'HDFCBANK', decision: 'PLACED' }).lean();
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.outcome.exitReason, 'TIME');
    assert.equal((await Position.findOne({ user: uid, symbol: 'ITC' })).status, 'OPEN');
  } finally {
    trader.stop();
  }
});
