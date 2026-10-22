import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import request from 'supertest';
import { NewsItem } from '../src/models/index.js';
import { attachSocket } from '../src/socket/index.js';
import { setup, teardown, closeDb, registerUser } from './helpers.js';

after(closeDb);

const DAY = 86400;
const T0 = Date.UTC(2026, 9, 21, 3, 45) / 1000; // 09:15 IST yesterday
/** One quiet session that closes at `close` inside a 990-1010 range. */
const yesterday = (close) => Array.from({ length: 375 }, (_, i) => ({ time: T0 + i * 60, open: 1000, high: 1010, low: 990, close: i === 374 ? close : 1000, volume: 100 }));

test('morning plan: names the stocks with news or a strong close and the level to wait for', async () => {
  const now = new Date('2026-10-22T03:30:00Z'); // 09:00 IST
  const ctx = await setup({}, { now: () => now });
  const { auth } = await registerUser(ctx.app);
  // INFY: good news and closed near the high. TCS: closed near the high only. ITC: nothing.
  ctx.scanner.store.bars.set('INFY', yesterday(1009));
  ctx.scanner.store.bars.set('TCS', yesterday(1009));
  ctx.scanner.store.bars.set('ITC', yesterday(1000));
  ctx.scanner.store.bars.set('SBIN', yesterday(991)); // closed near the low, plus bad news
  await NewsItem.create({ symbol: 'INFY', hash: 'a', title: 'Infosys wins big order', url: 'https://n.test/a', publishedAt: new Date(now.getTime() - 3600_000), sentiment: 2, label: 'BULLISH', category: 'ORDER_WIN' });
  await NewsItem.create({ symbol: 'SBIN', hash: 'b', title: 'SBI faces SEBI penalty', url: 'https://n.test/b', publishedAt: new Date(now.getTime() - 3600_000), sentiment: -2, label: 'BEARISH', category: 'REGULATORY' });

  const res = await request(ctx.app).get('/api/scanner/plan').set(auth).expect(200);
  const by = Object.fromEntries(res.body.items.map((i) => [i.symbol, i]));
  assert.equal(by.INFY.bias, 'BUY');
  assert.equal(by.INFY.trigger.price, 1010); // yesterday's high
  assert.ok(by.INFY.why.some((w) => /news/i.test(w)) && by.INFY.why.some((w) => /near the high/.test(w)));
  assert.equal(by.SBIN.bias, 'SELL');
  assert.equal(by.SBIN.trigger.price, 990); // yesterday's low
  assert.equal(by.TCS, undefined); // one weak reason is not enough
  assert.equal(by.ITC, undefined);
  assert.ok(res.body.items[0].score >= res.body.items[1].score);
  assert.match(res.body.disclaimer, /Not investment advice/);
  await teardown(ctx);
});

test('plan goes out once per trading day from 09:00 IST, never on a weekend', async () => {
  let clock = new Date('2026-10-22T03:00:00Z'); // 08:30 IST Thursday
  const ctx = await setup({}, { now: () => clock });
  const plans = [];
  ctx.scanner.on('plan', (p) => plans.push(p));
  assert.equal(await ctx.scanner.announcePlan(), null); // too early
  clock = new Date('2026-10-22T03:31:00Z');
  assert.ok(await ctx.scanner.announcePlan());
  assert.equal(await ctx.scanner.announcePlan(), null); // already sent today
  clock = new Date('2026-10-24T04:00:00Z'); // Saturday
  assert.equal(await ctx.scanner.announcePlan(), null);
  assert.equal(plans.length, 1);
  await teardown(ctx);
});

test('socket pushes scanner entry, closed and plan alerts to connected browsers', async () => {
  const ctx = await setup();
  const user = await registerUser(ctx.app);
  const server = http.createServer(ctx.app);
  const io = attachSocket(server, ctx);
  await new Promise((r) => server.listen(0, r));
  const client = connect(`http://127.0.0.1:${server.address().port}`, { auth: { token: user.token }, transports: ['websocket'] });
  await new Promise((r) => client.on('connect', r));

  const got = [];
  for (const e of ['scanner:entry', 'scanner:closed', 'scanner:plan']) client.on(e, (p) => got.push([e, p]));
  const idea = { symbol: 'SBIN', side: 'BUY', setup: 'Opening range breakout', entry: 800, stopLoss: 790, target1: 815, score: 82, status: 'OPEN', card: { secret: 'not sent' } };
  ctx.scanner.emit('entry', idea);
  ctx.scanner.emit('closed', { ...idea, status: 'TARGET_HIT', exitPrice: 815 });
  ctx.scanner.emit('plan', { items: [{ symbol: 'INFY', bias: 'BUY' }, { symbol: 'SBIN', bias: 'SELL' }] });
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(got.map((g) => g[0]), ['scanner:entry', 'scanner:closed', 'scanner:plan']);
  assert.equal(got[0][1].symbol, 'SBIN');
  assert.equal(got[0][1].card, undefined);
  assert.equal(got[1][1].exitPrice, 815);
  assert.deepEqual(got[2][1], { count: 2, symbols: ['INFY BUY', 'SBIN SELL'] });

  client.close();
  io.closeAll();
  assert.equal(ctx.scanner.listenerCount('entry'), 0);
  server.close();
  await teardown(ctx);
});
