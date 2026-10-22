import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser } from './helpers.js';
import { attachSocket } from '../src/socket/index.js';

after(closeDb);

test('socket relays ticks, depth and fills to an authenticated client', async () => {
  const ctx = await setup();
  const user = await registerUser(ctx.app);
  const server = http.createServer(ctx.app);
  const io = attachSocket(server, ctx);
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const rejected = connect(url, { auth: { token: 'bad' }, transports: ['websocket'] });
  await new Promise((r) => rejected.on('connect_error', r));
  rejected.close();

  const client = connect(url, { auth: { token: user.token }, transports: ['websocket'] });
  await new Promise((r) => client.on('connect', r));
  await new Promise((r) => client.emit('subscribe', { symbols: ['SBIN'], depth: true }, r));

  const tick = new Promise((r) => client.on('tick', (t) => t.symbol === 'SBIN' && t.ltp === 850 && r(t)));
  ctx.provider.setPrice('SBIN', 850);
  const t = await tick;
  assert.equal(t.depth.bids.length, 5);
  assert.equal(t.source, 'mock');

  const fill = new Promise((r) => client.on('order:update', (e) => e.kind === 'fill' && r(e)));
  await request(ctx.app).post('/api/orders').set(user.auth).send({ symbol: 'SBIN', side: 'BUY', qty: 2 }).expect(201);
  const evt = await fill;
  assert.match(evt.message, /Order filled: BUY 2 SBIN/);

  client.close();
  io.closeAll();
  server.close();
  await teardown(ctx);
});
