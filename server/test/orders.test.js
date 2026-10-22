import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser, settle } from './helpers.js';
import { calculateCharges } from '../src/services/charges.js';

let ctx;
let user;
const api = () => request(ctx.app);
const place = (body) => api().post('/api/orders').set(user.auth).send(body);
const funds = async () => (await api().get('/api/wallet').set(user.auth).expect(200)).body;
const openPositions = async () => (await api().get('/api/positions?status=OPEN').set(user.auth).expect(200)).body.positions;

beforeEach(async () => {
  ctx = await setup();
  user = await registerUser(ctx.app);
  ctx.provider.setPrice('RELIANCE', 1000);
});
afterEach(() => teardown(ctx));
after(closeDb);

test('new account starts with ₹1,00,000 and APIs require auth', async () => {
  const f = await funds();
  assert.equal(f.balance, 100000);
  assert.equal(f.available, 100000);
  await api().get('/api/wallet').expect(401);
  await api().get('/api/market/snapshot').expect(401);
});

test('market buy fills at LTP, blocks MIS margin and books charges', async () => {
  const res = await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET', qty: 10 }).expect(201);
  assert.equal(res.body.order.status, 'FILLED');
  assert.equal(res.body.order.avgFillPrice, 1000);

  const buyCharges = calculateCharges({ side: 'BUY', qty: 10, price: 1000 }).total;
  const f = await funds();
  assert.equal(f.usedMargin, 2000); // ₹10,000 / 5x
  assert.equal(f.balance, +(100000 - buyCharges).toFixed(2));

  const [pos] = await openPositions();
  assert.equal(pos.netQty, 10);
  assert.equal(pos.avgPrice, 1000);
  assert.equal(pos.direction, 'LONG');
});

test('closing a long books realised P&L net of both sides of charges', async () => {
  await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET', qty: 10 }).expect(201);
  ctx.provider.setPrice('RELIANCE', 1010);
  await place({ symbol: 'RELIANCE', side: 'SELL', orderType: 'MARKET', qty: 10 }).expect(201);

  const charges = calculateCharges({ side: 'BUY', qty: 10, price: 1000 }).total + calculateCharges({ side: 'SELL', qty: 10, price: 1010 }).total;
  const f = await funds();
  assert.equal(f.usedMargin, 0);
  assert.equal(f.balance, +(100000 + 100 - charges).toFixed(2));
  assert.equal((await openPositions()).length, 0);

  const trades = (await api().get('/api/trades').set(user.auth).expect(200)).body.trades;
  assert.equal(trades.length, 2);
  assert.equal(trades[0].realizedPnl, 100);
});

test('short selling intraday works and profits when price falls', async () => {
  await place({ symbol: 'RELIANCE', side: 'SELL', orderType: 'MARKET', qty: 5 }).expect(201);
  ctx.provider.setPrice('RELIANCE', 990);
  await api().post('/api/positions/RELIANCE/exit').set(user.auth).expect(200);
  const dash = (await api().get('/api/dashboard').set(user.auth).expect(200)).body;
  assert.equal(dash.totals.grossRealized, 50);
  assert.equal(dash.stats.trades, 1);
  assert.equal(dash.stats.wins, 1);
  assert.equal(dash.stats.winRate, 100);
});

test('rejects orders that exceed available margin', async () => {
  // ₹6,00,000 of stock needs ₹1,20,000 margin at 5x.
  const res = await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET', qty: 600 }).expect(200);
  assert.equal(res.body.order.status, 'REJECTED');
  assert.match(res.body.order.rejectReason, /Insufficient funds/);
  assert.equal((await funds()).balance, 100000);
});

test('validates quantity, symbol and SL/target direction', async () => {
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 0 }).expect(400);
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 1.5 }).expect(400);
  await place({ symbol: 'AAPL', side: 'BUY', qty: 1 }).expect(400);
  await place({ symbol: 'NIFTY 50', side: 'BUY', qty: 1 }).expect(400);
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 1, stopLoss: 1005 }).expect(400);
  await place({ symbol: 'RELIANCE', side: 'SELL', qty: 1, target: 1005 }).expect(400);
  await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'LIMIT', qty: 1 }).expect(400);
  await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'LIMIT', qty: 1, price: 500 }).expect(400);
});

test('limit buy rests with blocked margin and fills when LTP reaches it', async () => {
  const res = await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'LIMIT', qty: 10, price: 995 }).expect(201);
  assert.equal(res.body.order.status, 'OPEN');
  assert.equal((await funds()).blockedMargin, 1990);

  ctx.provider.setPrice('RELIANCE', 996);
  await settle();
  assert.equal((await openPositions()).length, 0);

  ctx.provider.setPrice('RELIANCE', 994.5);
  await settle();
  const [pos] = await openPositions();
  assert.equal(pos.netQty, 10);
  assert.equal(pos.avgPrice, 994.5);
  const f = await funds();
  assert.equal(f.blockedMargin, 0);
  assert.equal(f.usedMargin, 1989);
});

test('marketable limit fills immediately at LTP', async () => {
  const res = await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'LIMIT', qty: 1, price: 1010 }).expect(201);
  assert.equal(res.body.order.status, 'FILLED');
  assert.equal(res.body.order.avgFillPrice, 1000);
});

test('cancel a resting order releases its margin', async () => {
  const res = await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'LIMIT', qty: 10, price: 990 }).expect(201);
  await api().delete(`/api/orders/${res.body.order._id}`).set(user.auth).expect(200);
  assert.equal((await funds()).blockedMargin, 0);
  await api().delete(`/api/orders/${res.body.order._id}`).set(user.auth).expect(400);
});

test('stop-loss leg exits the position and cancels the target (OCO)', async () => {
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 10, stopLoss: 990, target: 1020 }).expect(201);
  let orders = (await api().get('/api/orders?status=OPEN').set(user.auth)).body.orders;
  assert.deepEqual(orders.map((o) => o.role).sort(), ['STOPLOSS', 'TARGET']);

  ctx.provider.setPrice('RELIANCE', 989);
  await settle();
  assert.equal((await openPositions()).length, 0);
  orders = (await api().get('/api/orders').set(user.auth)).body.orders;
  assert.equal(orders.find((o) => o.role === 'STOPLOSS').status, 'FILLED');
  assert.equal(orders.find((o) => o.role === 'TARGET').status, 'CANCELLED');
  const dash = (await api().get('/api/dashboard').set(user.auth)).body;
  assert.equal(dash.stats.losses, 1);
  assert.equal(dash.totals.grossRealized, -110);
});

test('target leg books profit on a short', async () => {
  await place({ symbol: 'RELIANCE', side: 'SELL', qty: 4, stopLoss: 1010, target: 980 }).expect(201);
  ctx.provider.setPrice('RELIANCE', 979.5);
  await settle();
  assert.equal((await openPositions()).length, 0);
  const trades = (await api().get('/api/trades').set(user.auth)).body.trades;
  assert.equal(trades[0].role, 'TARGET');
  assert.equal(trades[0].realizedPnl, 82);
});

test('manual exit cancels the pending SL/target legs', async () => {
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 2, stopLoss: 990, target: 1020 }).expect(201);
  await api().post('/api/positions/RELIANCE/exit').set(user.auth).expect(200);
  const open = (await api().get('/api/orders?status=OPEN').set(user.auth)).body.orders;
  assert.equal(open.length, 0);
});

test('one order can close a long and open a short', async () => {
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 5 }).expect(201);
  ctx.provider.setPrice('RELIANCE', 1002);
  await place({ symbol: 'RELIANCE', side: 'SELL', qty: 8 }).expect(201);
  const [pos] = await openPositions();
  assert.equal(pos.netQty, -3);
  assert.equal(pos.direction, 'SHORT');
  assert.equal(pos.avgPrice, 1002);
  const trades = (await api().get('/api/trades').set(user.auth)).body.trades;
  assert.equal(trades.length, 3);
  assert.equal(trades.find((t) => t.realizedPnl === 10).qty, 5);
});

test('exit-all squares off every position', async () => {
  ctx.provider.setPrice('TCS', 3000);
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 1 }).expect(201);
  await place({ symbol: 'TCS', side: 'SELL', qty: 1 }).expect(201);
  await place({ symbol: 'TCS', side: 'BUY', orderType: 'LIMIT', price: 2950, qty: 1 }).expect(201);
  const res = await api().post('/api/positions/exit-all').set(user.auth).expect(200);
  assert.equal(res.body.positionsExited, 2);
  assert.equal((await openPositions()).length, 0);
  assert.equal((await funds()).blockedMargin, 0);
});

test('wallet reset wipes history and restores ₹1,00,000', async () => {
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 3 }).expect(201);
  const f = (await api().post('/api/wallet/reset').set(user.auth).expect(200)).body;
  assert.equal(f.balance, 100000);
  assert.equal(f.resetCount, 1);
  assert.equal((await api().get('/api/orders').set(user.auth)).body.orders.length, 0);
});

test('users cannot see or cancel each other\'s orders', async () => {
  const res = await place({ symbol: 'RELIANCE', side: 'BUY', orderType: 'LIMIT', qty: 1, price: 990 }).expect(201);
  const other = await registerUser(ctx.app);
  await api().delete(`/api/orders/${res.body.order._id}`).set(other.auth).expect(404);
  assert.equal((await api().get('/api/orders').set(other.auth)).body.orders.length, 0);
});

test('dashboard: win rate, best/worst, equity curve, daily P&L', async () => {
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 10 }).expect(201);
  ctx.provider.setPrice('RELIANCE', 1020);
  await place({ symbol: 'RELIANCE', side: 'SELL', qty: 10 }).expect(201);
  await place({ symbol: 'RELIANCE', side: 'BUY', qty: 10 }).expect(201);
  ctx.provider.setPrice('RELIANCE', 1015);
  await place({ symbol: 'RELIANCE', side: 'SELL', qty: 10 }).expect(201);

  const d = (await api().get('/api/dashboard').set(user.auth)).body;
  assert.equal(d.stats.trades, 2);
  assert.equal(d.stats.winRate, 50);
  assert.ok(d.stats.best.net > 0 && d.stats.worst.net < 0);
  assert.equal(d.equityCurve.length, 5);
  assert.equal(d.dailyPnl.length, 1);
  assert.equal(d.dailyPnl[0].pnl, d.totals.realizedNet);
  assert.equal(d.totals.grossRealized, 150);
});
