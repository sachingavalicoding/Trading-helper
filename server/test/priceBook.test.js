import test from 'node:test';
import assert from 'node:assert/strict';
import { PriceBook } from '../src/study/priceBook.js';
import { simulateTrade } from '../src/study/simulate.js';

const BASE = Date.UTC(2026, 9, 28, 3, 45) / 1000; // 28 Oct 2026, 09:15 IST
const DAY = '2026-10-28';
const bars = Array.from({ length: 21 }, (_, i) => ({ time: BASE + i * 60, open: 23000 + i, high: 23001.5 + i, low: 22999.5 + i, close: 23001 + i, volume: 1000 }));
const byTime = new Map(bars.map((b, i) => [b.time, i]));
const signal = { side: 'CE', time: BASE + 2 * 60, stop: 22900, technique: 'test' };
const params = { steps: [], lotSize: 65, holidays: [] };
// a call that gains ₹1 a minute: open 100 + i, close 101 + i
const callCandles = bars.map((b, i) => ({ time: b.time, open: 100 + i, high: 101.5 + i, low: 99.5 + i, close: 101 + i, volume: 500, oi: 1000 }));
const book = () => PriceBook.fromContracts([{ day: DAY, expiry: '2026-11-03', strike: 23000, type: 'CE', candles: callCandles }]);

test('with saved prices a trade is bought and sold at the contract\'s own candle prices', () => {
  const prices = book();
  const t = simulateTrade({ c1: bars, byTime, signal, params: { ...params, prices } });
  assert.equal(t.priced, 'real');
  assert.equal(t.expiry, '2026-11-03', 'the saved expiry, not a guessed one');
  assert.equal(t.strike, 23000);
  assert.equal(t.entryPremium, 102.31, 'the open of the entry minute (102) plus 0.3% slippage');
  assert.ok(Math.abs(t.gross - 1191.52) < 0.05, `sold at the last candle's close (121): ${t.gross}`);
  assert.equal(prices.stats.used, 1);
});

test('a trade whose contract was not saved is skipped, not guessed', () => {
  const prices = PriceBook.fromContracts([{ day: DAY, expiry: '2026-11-03', strike: 23050, type: 'CE', candles: callCandles }]);
  const t = simulateTrade({ c1: bars, byTime, signal, params: { ...params, prices } });
  assert.equal(t, null);
  assert.equal(prices.stats.noPrice, 1);
  const other = PriceBook.fromContracts([{ day: '2026-10-27', expiry: '2026-11-03', strike: 23000, type: 'CE', candles: callCandles }]);
  assert.equal(simulateTrade({ c1: bars, byTime, signal, params: { ...params, prices: other } }), null, 'a day with nothing saved is skipped too');
});

test('without saved prices the trade is estimated as before', () => {
  const t = simulateTrade({ c1: bars, byTime, signal, params });
  assert.equal(t.priced, 'estimated');
});

test('the book lists its days and expiries and says what it used', () => {
  const prices = book();
  assert.deepEqual(prices.days, [DAY]);
  assert.deepEqual(prices.expiries(DAY), ['2026-11-03']);
  assert.equal(prices.contract(DAY, '2026-11-03', 23000, 'PE'), null);
  simulateTrade({ c1: bars, byTime, signal, params: { ...params, prices } });
  assert.deepEqual(prices.describe(), { mode: 'real', days: 1, from: DAY, to: DAY, priced: 1, skipped: 0 });
});
