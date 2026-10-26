import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser, settle } from './helpers.js';
import { createApp } from '../src/app.js';
import { AutoTrader } from '../src/auto/autoTrader.js';
import { AutoSettings, Order, Position } from '../src/models/index.js';

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
