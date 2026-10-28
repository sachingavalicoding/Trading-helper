import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser, settle } from './helpers.js';
import { Order } from '../src/models/index.js';

let ctx;
let user;
const api = () => request(ctx.app);
const buy = (body = {}) => api().post('/api/orders').set(user.auth).send({ symbol: 'RELIANCE', side: 'BUY', qty: 10, ...body });
const exits = (body, symbol = 'RELIANCE') => api().put(`/api/positions/${symbol}/exits`).set(user.auth).send(body);
const openLegs = (role) => Order.find({ symbol: 'RELIANCE', status: 'OPEN', role }).lean();

beforeEach(async () => {
  ctx = await setup();
  user = await registerUser(ctx.app);
  ctx.provider.setPrice('RELIANCE', 1000);
  await settle();
  // These tests set their own exits, so start from no automatic stop and no automatic lock.
  await api().put('/api/trade-defaults').set(user.auth).send({ shares: { stopLoss: 0, lockStart: 0 } }).expect(200);
});
afterEach(() => teardown(ctx));
after(closeDb);

test('adds, changes and removes the stop loss and target of an open position', async () => {
  await buy().expect(201);
  assert.equal((await openLegs('STOPLOSS')).length, 0);

  const added = (await exits({ stopLoss: 990, target: 1020 }).expect(200)).body;
  assert.equal(added.stopLoss, 990);
  assert.equal(added.target, 1020);

  const moved = (await exits({ stopLoss: 995 }).expect(200)).body;
  assert.equal(moved.stopLoss, 995);
  assert.equal(moved.target, 1020, 'a field left out is kept');
  assert.equal((await openLegs('STOPLOSS')).length, 1);

  const removed = (await exits({ target: null }).expect(200)).body;
  assert.equal(removed.target, null);
  assert.equal(removed.stopLoss, 995);

  const list = (await api().get('/api/positions?status=OPEN').set(user.auth).expect(200)).body.positions;
  assert.equal(list[0].stopLoss, 995);

  // the edited stop still fires
  ctx.provider.setPrice('RELIANCE', 994);
  await settle();
  const pos = (await api().get('/api/positions?status=ALL').set(user.auth).expect(200)).body.positions[0];
  assert.equal(pos.status, 'CLOSED');
});

test('rejects a stop on the wrong side of the price, and a stock with no position', async () => {
  await buy().expect(201);
  await exits({ stopLoss: 1010 }).expect(400);
  await exits({ target: 990 }).expect(400);
  await exits({ stopLoss: 990 }, 'TCS').expect(404);
  await exits({ trailPct: 50 }).expect(400);
});

test('a trailing stop follows the price up and never moves back down', async () => {
  await buy({ stopLoss: 990 }).expect(201);
  await exits({ trailPct: 1 }).expect(200);
  ctx.provider.setPrice('RELIANCE', 1020);
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1009.8);
  ctx.provider.setPrice('RELIANCE', 1012);
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1009.8, 'it does not loosen when price dips');
  ctx.provider.setPrice('RELIANCE', 1009);
  await settle();
  const pos = (await api().get('/api/positions?status=ALL').set(user.auth).expect(200)).body.positions[0];
  assert.equal(pos.status, 'CLOSED', 'the trailed stop was hit in profit');
  assert.ok(pos.realizedPnl > 0);
});

test('a short position trails downwards, and a trail with no stop starts one', async () => {
  await buy({ side: 'SELL' }).expect(201);
  await exits({ trailPct: 1 }).expect(200);
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1010);
  ctx.provider.setPrice('RELIANCE', 980);
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 989.8);
});

test('profit lock: at the start profit the stop keeps start minus gap, then follows the gap behind the best profit', async () => {
  await api().put('/api/trade-defaults').set(user.auth).send({ shares: { lockStart: 1000, lockGap: 100 } }).expect(200);
  await buy({ qty: 100 }).expect(201);
  assert.equal((await openLegs('STOPLOSS')).length, 0);
  ctx.provider.setPrice('RELIANCE', 1005); // Rs 500 profit: not yet
  await settle();
  assert.equal((await openLegs('STOPLOSS')).length, 0);
  ctx.provider.setPrice('RELIANCE', 1010); // Rs 1000 profit: stop goes to +900
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1009);
  ctx.provider.setPrice('RELIANCE', 1011); // +1100: stop +1000
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1010);
  ctx.provider.setPrice('RELIANCE', 1020);
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1019);
  ctx.provider.setPrice('RELIANCE', 1018); // back through the stop at +1900
  await settle();
  const pos = (await api().get('/api/positions?status=ALL').set(user.auth).expect(200)).body.positions[0];
  assert.equal(pos.status, 'CLOSED');
  assert.ok(pos.realizedPnl >= 1800, `locked a profit, got ${pos.realizedPnl}`);
});

test('the profit lock can be edited per position and cleared, and is validated', async () => {
  await buy({ qty: 100 }).expect(201);
  const set = (await exits({ lockTrigger: 500, lockAmount: 100 }).expect(200)).body;
  assert.equal(set.lockTrigger, 500);
  assert.equal(set.lockAmount, 100);
  await exits({ lockTrigger: 100, lockAmount: 200 }).expect(400);
  await exits({ lockTrigger: 800, lockAmount: null }).expect(400);
  ctx.provider.setPrice('RELIANCE', 1005); // Rs 500 profit hits the new trigger
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1001.25, 'Rs 100 locked is raised to cost plus 1.5x the charges');
  const cleared = (await exits({ lockTrigger: null, lockAmount: null }).expect(200)).body;
  assert.equal(cleared.lockTrigger, null);
});

test('your stop and profit lock apply to every new position: a fixed rupee stop, and a lock that follows a set gap behind the profit', async () => {
  const d0 = (await api().get('/api/trade-defaults').set(user.auth).expect(200)).body;
  assert.deepEqual(d0.options, { stopLoss: 1500, lockStart: 1000, lockGap: 250 });
  await api().put('/api/trade-defaults').set(user.auth).send({ shares: { lockStart: 100, lockGap: 200 } }).expect(400);
  const set = (await api().put('/api/trade-defaults').set(user.auth).send({ shares: { stopLoss: 200, lockStart: 250, lockGap: 50 } }).expect(200)).body;
  assert.deepEqual(set.shares, { stopLoss: 200, lockStart: 250, lockGap: 50 });
  assert.deepEqual(set.options, d0.options, 'options are kept apart from shares');

  await buy({ qty: 100 }).expect(201);
  const e = (await exits({}).expect(200)).body;
  assert.equal(e.stopLoss, 998, 'a manual order without a stop gets one that loses 200 rupees: 2 a share on 100 shares');
  assert.equal(e.lockTrigger, 250);
  assert.equal(e.lockAmount, 200);

  ctx.provider.setPrice('RELIANCE', 1003); // +300 profit: the stop keeps 250
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1002.5);
  ctx.provider.setPrice('RELIANCE', 1006); // +600: it follows 50 behind
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1005.5);
  await api().post('/api/positions/RELIANCE/exit').set(user.auth).expect(200);

  // an order that brings its own stop keeps it, and a stop of 0 switches the automatic stop off
  ctx.provider.setPrice('RELIANCE', 1000);
  await settle();
  await buy({ qty: 100, stopLoss: 990 }).expect(201);
  assert.equal((await exits({}).expect(200)).body.stopLoss, 990);
  await api().post('/api/positions/RELIANCE/exit').set(user.auth).expect(200);
  await api().put('/api/trade-defaults').set(user.auth).send({ shares: { stopLoss: 0, lockStart: 0 } }).expect(200);
  await buy({ qty: 100 }).expect(201);
  const none = (await exits({}).expect(200)).body;
  assert.equal(none.stopLoss, null);
  assert.equal(none.lockTrigger, null);
});

test('a profit lock never puts the stop where the trade would net a loss after charges', async () => {
  await buy({ qty: 100 }).expect(201);
  await exits({ lockTrigger: 100, lockAmount: 5 }).expect(200); // Rs 5 locked is less than the charges
  ctx.provider.setPrice('RELIANCE', 1001); // Rs 100 profit: the lock starts, but price is not far enough above cost + charges to place a stop there
  await settle();
  assert.equal((await openLegs('STOPLOSS')).length, 0, 'no stop that would net a loss');
  ctx.provider.setPrice('RELIANCE', 1003);
  await settle();
  const stop = (await openLegs('STOPLOSS'))[0].triggerPrice;
  assert.ok(stop >= 1001.2, `stop ${stop} sits above cost plus charges, not at cost + Rs 0.05`);
});
