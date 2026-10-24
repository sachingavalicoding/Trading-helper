import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { totp } from '../src/services/totp.js';
import { buildPacket, parsePacket, looksSane, MODE } from '../src/market/providers/angelone/packet.js';
import { AngelOneProvider, toTick } from '../src/market/providers/angelone/AngelOneProvider.js';
import { createProvider } from '../src/market/providers/index.js';

const CREDS = { apiKey: 'KEY', clientCode: 'A123456', pin: '1234', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };

test('totp matches the RFC 6238 test vectors', () => {
  assert.equal(totp(CREDS.totpSecret, 59_000, { digits: 8 }), '94287082');
  assert.equal(totp(CREDS.totpSecret, 1111111109_000, { digits: 8 }), '07081804');
  assert.equal(totp(CREDS.totpSecret, 59_000), '287082');
  assert.equal(totp('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', 59_000), '287082'); // spaces and dashes are ignored
  assert.throws(() => totp('not base32!1', 0), /base32/);
});

test('packet: a built snap quote decodes back, with the book split into bids and asks', () => {
  const buf = buildPacket({
    token: '2885',
    ltp: 1250.55,
    open: 1240,
    high: 1255.1,
    low: 1238.25,
    prevClose: 1241.4,
    volume: 5_400_000,
    totalBuyQty: 120000,
    totalSellQty: 90000,
    ts: 1_800_000_000_000,
    bids: [1250.5, 1250.45, 1250.4, 1250.35, 1250.3].map((price, i) => ({ price, qty: 100 * (i + 1) })),
    asks: [1250.6, 1250.65, 1250.7, 1250.75, 1250.8].map((price, i) => ({ price, qty: 50 * (i + 1) })),
  });
  const p = parsePacket(buf);
  assert.equal(p.token, '2885');
  assert.equal(p.mode, MODE.SNAP_QUOTE);
  assert.equal(p.ltp, 1250.55);
  assert.equal(p.prevClose, 1241.4);
  assert.equal(p.volume, 5_400_000);
  assert.equal(p.totalBuyQty, 120000);
  assert.equal(p.exchangeTs, 1_800_000_000_000);
  assert.equal(p.depth.bids.length, 5);
  assert.equal(p.depth.bids[0].price, 1250.5);
  assert.equal(p.depth.asks[4].qty, 250);
  assert.ok(looksSane(p));
  assert.equal(parsePacket(Buffer.alloc(10)), null);
  assert.equal(parsePacket(buildPacket({ token: '2885', ltp: 100, mode: MODE.LTP })).high, undefined);
});

test('packet: a shifted layout is caught by the sanity check', () => {
  const buf = buildPacket({ token: '2885', ltp: 100, high: 101, low: 99, prevClose: 100 });
  const shifted = Buffer.concat([Buffer.alloc(4), buf]); // every field 4 bytes later
  assert.ok(!looksSane(parsePacket(shifted)));
});

test('toTick: normalizes prices, sorts the book and keeps indices free of depth', () => {
  const pkt = parsePacket(buildPacket({ token: '2885', ltp: 110, open: 100, high: 112, low: 99, prevClose: 100, volume: 10, bids: [{ price: 109.9, qty: 5 }, { price: 110, qty: 7 }], asks: [{ price: 110.2, qty: 3 }, { price: 110.1, qty: 4 }] }));
  const t = toTick('RELIANCE', pkt);
  assert.equal(t.change, 10);
  assert.equal(t.changePct, 10);
  assert.deepEqual(t.depth.bids.map((b) => b.price), [110, 109.9]);
  assert.deepEqual(t.depth.asks.map((a) => a.price), [110.1, 110.2]);
  assert.equal(t.source, 'angelone');
  assert.equal(toTick('NIFTY 50', parsePacket(buildPacket({ token: '99926000', ltp: 25000, prevClose: 24900, high: 25010, low: 24890 }))).isIndex, true);
});

// ---- provider against a fake broker ----
class FakeSocket extends EventEmitter {
  static last = null;
  constructor(url, opts) {
    super();
    Object.assign(this, { url, opts, sent: [], readyState: 1 });
    FakeSocket.last = this;
  }
  send(m) {
    this.sent.push(m);
  }
  close() {
    this.readyState = 3;
  }
}

function fakeFetch(calls, { loginOk = true } = {}) {
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
  return async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('OpenAPIScripMaster')) return json([{ token: '2885', symbol: 'RELIANCE-EQ', exch_seg: 'NSE' }, { token: '11536', symbol: 'TCS-EQ', exch_seg: 'NSE' }, { token: '1', symbol: 'RELIANCE-BE', exch_seg: 'NSE' }]);
    if (url.includes('loginByPassword')) return json(loginOk ? { status: true, data: { jwtToken: 'Bearer JWT123', refreshToken: 'R', feedToken: 'FEED' } } : { status: false, message: 'Invalid totp', errorcode: 'AB1050' });
    if (url.includes('getCandleData')) return json({ status: true, data: [['2026-10-22T09:16:00+05:30', 100, 101, 99, 100.5, 10], ['2026-10-22T09:15:00+05:30', 99, 100, 98, 100, 20], ['2026-10-22T09:15:00+05:30', 99, 100, 98, 100, 20]] });
    throw new Error(`unexpected ${url}`);
  };
}

const make = (calls, opts) => new AngelOneProvider(CREDS, { fetchImpl: fakeFetch(calls, opts), WebSocketImpl: FakeSocket, cache: false, now: () => Date.parse('2026-10-22T05:00:00Z') });

test('provider: logs in with a TOTP, maps tokens, opens the feed with the right headers and subscribes', async () => {
  const calls = [];
  const p = make(calls);
  await p.connect();

  const login = calls.find((c) => c.url.includes('loginByPassword'));
  assert.deepEqual(Object.keys(login.body).sort(), ['clientcode', 'password', 'totp']);
  assert.equal(login.body.clientcode, 'A123456');
  assert.match(login.body.totp, /^\d{6}$/);
  assert.equal(login.init.headers['X-PrivateKey'], 'KEY');
  assert.equal(login.init.headers.Authorization, undefined);

  const ws = FakeSocket.last;
  assert.equal(ws.opts.headers['x-feed-token'], 'FEED');
  assert.equal(ws.opts.headers['x-client-code'], 'A123456');
  assert.equal(ws.opts.headers.Authorization, 'JWT123'); // "Bearer " is stripped from the login token

  ws.emit('open');
  await p.subscribe(['RELIANCE', 'TCS', 'NIFTY 50', 'NOPE']);
  const frame = JSON.parse(ws.sent.at(-1));
  assert.equal(frame.action, 1);
  assert.equal(frame.params.mode, MODE.SNAP_QUOTE);
  assert.deepEqual(frame.params.tokenList, [{ exchangeType: 1, tokens: ['2885', '11536', '99926000'] }]);

  const got = [];
  p.on('tick', (t) => got.push(t));
  ws.emit('message', buildPacket({ token: '2885', ltp: 1250, high: 1255, low: 1240, prevClose: 1245, volume: 100 }), true);
  ws.emit('message', buildPacket({ token: '2885', ltp: 1, high: 5, low: 2, prevClose: 1 }), true); // inconsistent, dropped
  ws.emit('message', buildPacket({ token: '999', ltp: 10, high: 11, low: 9 }), true); // unknown token, ignored
  ws.emit('message', Buffer.from('pong'), false);
  assert.equal(got.length, 1);
  assert.equal(got[0].symbol, 'RELIANCE');
  assert.equal(got[0].ltp, 1250);
  assert.equal(p.connected, true);
  await p.disconnect();
});

test('provider: history asks for the right interval and window, dedupes and sorts oldest first', async () => {
  const calls = [];
  const p = make(calls);
  await p.connect();
  const candles = await p.getHistory('RELIANCE', '5m');
  const req = calls.find((c) => c.url.includes('getCandleData'));
  assert.equal(req.body.exchange, 'NSE');
  assert.equal(req.body.symboltoken, '2885');
  assert.equal(req.body.interval, 'FIVE_MINUTE');
  assert.equal(req.body.todate, '2026-10-22 10:30'); // 05:00 UTC is 10:30 IST
  assert.equal(req.body.fromdate, '2026-10-12 10:30');
  assert.equal(req.init.headers.Authorization, 'Bearer JWT123');
  assert.equal(candles.length, 2);
  assert.ok(candles[0].time < candles[1].time);
  assert.deepEqual(candles[1], { time: Date.parse('2026-10-22T09:16:00+05:30') / 1000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 });
  assert.deepEqual(await p.getHistory('NOPE', '1m'), []);
  await p.disconnect();
});

test('provider: a rejected login says what to check, and missing values are named', async () => {
  const p = make([], { loginOk: false });
  await assert.rejects(() => p.connect(), /login failed: Invalid totp \(AB1050\).*PIN.*clock/);
  const empty = new AngelOneProvider({ ...CREDS, pin: '' }, { fetchImpl: fakeFetch([]), WebSocketImpl: FakeSocket, cache: false });
  await assert.rejects(() => empty.connect(), /ANGELONE_PIN is empty/);
});

test('registry: MARKET_DATA_PROVIDER=angelone builds the Angel One provider', () => {
  const p = createProvider({ provider: 'angelone', angelone: CREDS });
  assert.equal(p.name, 'angelone');
  assert.equal(p.isSimulated, false);
  assert.equal(p.capabilities.depth, true);
});
