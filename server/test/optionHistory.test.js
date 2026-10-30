import test from 'node:test';
import assert from 'node:assert/strict';
import { packOptionCandles, unpackOptionCandles, pickContracts, RETAIN_DAYS } from '../src/market/optionHistory.js';

test('option candles pack to a small buffer and come back exactly, with the open interest', () => {
  const candles = Array.from({ length: 375 }, (_, i) => ({ time: 1_761_800_000 + i * 60, open: 120.05 + i * 0.1, high: 121.5 + i * 0.1, low: 119.2 + i * 0.1, close: 120.7 + i * 0.1, volume: 1000 + i, oi: 541_580 - i * 7 }));
  const buf = packOptionCandles(candles);
  const back = unpackOptionCandles(buf, candles.length);
  assert.equal(back.length, 375);
  assert.deepEqual(back[0], { ...candles[0], open: 120.05, high: 121.5, low: 119.2, close: 120.7 });
  assert.equal(back[374].oi, 541_580 - 374 * 7);
  assert.equal(back[200].close, Math.round(candles[200].close * 100) / 100);
  assert.ok(buf.length < 8000, `a contract-day should be a few KB, got ${buf.length}`);
});

test('the strikes saved for a day cover the whole range the index travelled plus a margin, both types, nearest the close first when capped', () => {
  const strikes = Array.from({ length: 81 }, (_, i) => 21_000 + i * 50); // 21000..25000
  const rows = strikes.flatMap((strike) => ['CE', 'PE'].map((type) => ({ symbol: `NIFTY ${strike} ${type}`, strike, type, expiry: '2026-11-03' })));
  const picked = pickContracts(rows, { low: 22_900, high: 23_200, close: 23_100, step: 50 });
  const ks = [...new Set(picked.map((r) => r.strike))];
  assert.equal(Math.min(...ks), 22_700, 'four steps below the low');
  assert.equal(Math.max(...ks), 23_400, 'four steps above the high');
  assert.equal(picked.length, ks.length * 2, 'a call and a put for each strike');
  assert.deepEqual(picked.slice(0, 2).map((r) => r.type), ['CE', 'PE']);
  const wide = pickContracts(rows, { low: 21_000, high: 25_000, close: 23_000, step: 50 });
  assert.equal(new Set(wide.map((r) => r.strike)).size, 41, 'capped at 41 strikes');
  assert.ok(wide.some((r) => r.strike === 23_000) && !wide.some((r) => r.strike === 21_000), 'the ones nearest the close are kept');
});

test('thirty trading days are kept', () => {
  assert.equal(RETAIN_DAYS, 30);
});
