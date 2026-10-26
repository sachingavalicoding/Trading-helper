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

test('profit lock: at the trigger profit the stop locks in the set amount, then follows the price', async () => {
  await buy({ qty: 100 }).expect(201); // defaults: trigger Rs 1000, lock Rs 400
  assert.equal((await openLegs('STOPLOSS')).length, 0);
  ctx.provider.setPrice('RELIANCE', 1005); // Rs 500 profit: not yet
  await settle();
  assert.equal((await openLegs('STOPLOSS')).length, 0);
  ctx.provider.setPrice('RELIANCE', 1010); // Rs 1000 profit: stop goes to cost + Rs 400
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1004);
  ctx.provider.setPrice('RELIANCE', 1020); // Rs 2000 profit: stop stays Rs 600 behind the best profit
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1014);
  ctx.provider.setPrice('RELIANCE', 1015);
  await settle();
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1014, 'never loosens');
  ctx.provider.setPrice('RELIANCE', 1013);
  await settle();
  const pos = (await api().get('/api/positions?status=ALL').set(user.auth).expect(200)).body.positions[0];
  assert.equal(pos.status, 'CLOSED');
  assert.ok(pos.realizedPnl >= 1300, `locked a profit, got ${pos.realizedPnl}`);
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
  assert.equal((await openLegs('STOPLOSS'))[0].triggerPrice, 1001);
  const cleared = (await exits({ lockTrigger: null, lockAmount: null }).expect(200)).body;
  assert.equal(cleared.lockTrigger, null);
});

test('your own defaults apply to new positions, and can be switched off', async () => {
  const d0 = (await api().get('/api/trade-defaults').set(user.auth).expect(200)).body;
  assert.deepEqual(d0, { lockEnabled: true, lockTrigger: 1000, lockAmount: 400 });
  await api().put('/api/trade-defaults').set(user.auth).send({ lockTrigger: 300, lockAmount: 500 }).expect(400);
  await api().put('/api/trade-defaults').set(user.auth).send({ lockTrigger: 300, lockAmount: 100 }).expect(200);
  await buy({ qty: 100 }).expect(201);
  assert.equal((await exits({}).expect(200)).body.lockTrigger, 300);
  await api().post('/api/positions/RELIANCE/exit').set(user.auth).expect(200);
  await api().put('/api/trade-defaults').set(user.auth).send({ lockEnabled: false }).expect(200);
  await buy({ qty: 100 }).expect(201);
  assert.equal((await exits({}).expect(200)).body.lockTrigger, null);
});
