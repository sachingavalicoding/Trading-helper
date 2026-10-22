import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser } from './helpers.js';

let ctx;
afterEach(() => teardown(ctx));
after(closeDb);

const wednesday = (hhmmIst) => {
  const [h, m] = hhmmIst.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 21, h, m) - 330 * 60000);
};

test('with hours enforced, orders are rejected when NSE is closed', async () => {
  ctx = await setup({ enforceMarketHours: true }, { now: () => wednesday('08:00') });
  const user = await registerUser(ctx.app);
  ctx.provider.setPrice('INFY', 1500);
  const res = await request(ctx.app).post('/api/orders').set(user.auth).send({ symbol: 'INFY', side: 'BUY', qty: 1 }).expect(200);
  assert.equal(res.body.order.status, 'REJECTED');
  assert.match(res.body.order.rejectReason, /Market is closed/);
});

test('auto square-off at 15:15 IST closes MIS positions once per day', async () => {
  let clock = wednesday('15:00');
  ctx = await setup({ enforceMarketHours: true }, { now: () => clock });
  const user = await registerUser(ctx.app);
  ctx.provider.setPrice('INFY', 1500);
  await request(ctx.app).post('/api/orders').set(user.auth).send({ symbol: 'INFY', side: 'BUY', qty: 4 }).expect(201);

  await ctx.engine.checkSquareOff();
  let open = (await request(ctx.app).get('/api/positions?status=OPEN').set(user.auth)).body.positions;
  assert.equal(open.length, 1, 'no square-off before 15:15');

  clock = wednesday('15:15');
  await ctx.engine.checkSquareOff();
  open = (await request(ctx.app).get('/api/positions?status=OPEN').set(user.auth)).body.positions;
  assert.equal(open.length, 0);
  const orders = (await request(ctx.app).get('/api/orders').set(user.auth)).body.orders;
  assert.equal(orders[0].role, 'SQUAREOFF');

  // New positions are blocked after square-off time.
  const res = await request(ctx.app).post('/api/orders').set(user.auth).send({ symbol: 'INFY', side: 'BUY', qty: 1 }).expect(200);
  assert.equal(res.body.order.status, 'REJECTED');
});
