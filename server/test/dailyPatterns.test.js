import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { dailyPatterns } from '../src/scanner/daily.js';
import { setup, teardown, closeDb, registerUser } from './helpers.js';

after(closeDb);

const dayKey = (iso) => Math.floor(Date.UTC(...iso) / 86400000);
const TODAY = dayKey([2026, 9, 22]); // 22 Oct 2026
/** One finished daily candle for the IST day `n` sessions before today. */
const candle = (n, high, low, close = (high + low) / 2) => ({ time: (TODAY - n) * 86400 - 19800 + 3600, open: close, high, low, close, volume: 1000 });
/** `count` ordinary sessions (range 20) ending yesterday, then optional overrides for the latest ones. */
const history = (count, { last = null, prev = null } = {}) => {
  const out = Array.from({ length: count }, (_, i) => candle(count - i, 1010, 990, 1000));
  if (prev) out[count - 2] = candle(2, ...prev);
  if (last) out[count - 1] = candle(1, ...last);
  return out;
};

test('NR7 and NR4: yesterday had the narrowest range, so price is coiled', () => {
  const p = dailyPatterns(history(30, { last: [1005, 997] }), TODAY);
  assert.equal(p.nr7, true);
  assert.equal(p.nr4, true);
  // Narrowest of the last 4 but not of the last 7.
  const h = history(30, { last: [1005, 997] });
  h[h.length - 6] = candle(6, 1002, 999);
  const q = dailyPatterns(h, TODAY);
  assert.equal(q.nr4, true);
  assert.equal(q.nr7, false);
  assert.equal(dailyPatterns(history(30), TODAY).nr7, false, 'identical ranges are not a narrow-range day');
});

test('inside bar: yesterday stayed within the day before it', () => {
  assert.equal(dailyPatterns(history(30, { prev: [1020, 980], last: [1010, 990] }), TODAY).insideBar, true);
  assert.equal(dailyPatterns(history(30, { prev: [1010, 990], last: [1015, 995] }), TODAY).insideBar, false);
  assert.equal(dailyPatterns(history(30, { prev: [1010, 990], last: [1010, 990] }), TODAY).insideBar, false, 'identical range is not an inside bar');
});

test('daily patterns ignore today\'s partial candle and tolerate missing data', () => {
  const h = history(30, { last: [1005, 997] });
  h.push(candle(0, 1500, 500)); // today, still forming: must not count
  const p = dailyPatterns(h, TODAY);
  assert.equal(p.nr7, true);
  assert.equal(p.sessions, 30);
  for (const bad of [null, undefined, [], history(5)]) {
    const r = dailyPatterns(bad, TODAY);
    assert.equal(r.nr7, false);
    assert.equal(r.insideBar, false);
  }
});

// ---- morning plan wiring ----
const T0 = Date.UTC(2026, 9, 21, 3, 45) / 1000; // 09:15 IST yesterday
const quietSession = (close) => Array.from({ length: 375 }, (_, i) => ({ time: T0 + i * 60, open: 1000, high: 1010, low: 990, close: i === 374 ? close : 1000, volume: 100 }));

test('morning plan: a coiled day lifts a stock that closed strong', async () => {
  const ctx = await setup({}, { now: () => new Date('2026-10-22T03:30:00Z') }); // 09:00 IST
  const { auth } = await registerUser(ctx.app);
  // All three closed near yesterday's high (+1 each), which alone is not enough to be listed.
  for (const s of ['INFY', 'WIPRO', 'ITC']) ctx.scanner.store.bars.set(s, quietSession(1009));
  ctx.scanner.daily.set('INFY', history(30, { last: [1005, 997, 1004] })); // NR7 only
  ctx.scanner.daily.set('WIPRO', history(30)); // nothing special
  // ITC has no daily candles at all.
  const res = await request(ctx.app).get('/api/scanner/plan').set(auth).expect(200);
  const by = Object.fromEntries(res.body.items.map((i) => [i.symbol, i]));
  assert.equal(by.INFY.bias, 'BUY'); // 1 + 0.5 coil bonus reaches the 1.5 cut-off
  assert.deepEqual(by.INFY.patterns, ['NR7']);
  assert.ok(by.INFY.why.some((w) => /coiled/.test(w)));
  assert.equal(by.WIPRO, undefined);
  assert.equal(by.ITC, undefined);
  await teardown(ctx);
});

test('morning plan: a coiled day alone adds no bias to a stock with none', async () => {
  const ctx = await setup({}, { now: () => new Date('2026-10-22T03:30:00Z') });
  const { auth } = await registerUser(ctx.app);
  ctx.scanner.store.bars.set('TCS', quietSession(1000)); // closed mid-range: no bias
  ctx.scanner.daily.set('TCS', history(30, { last: [1005, 997] })); // NR7
  const res = await request(ctx.app).get('/api/scanner/plan').set(auth).expect(200);
  assert.equal(res.body.items.find((i) => i.symbol === 'TCS'), undefined);
  await teardown(ctx);
});
