import test from 'node:test';
import assert from 'node:assert/strict';
import { dayStand, dayBiasSkip, streakSkip, dayBiasOf } from '../src/options/dayBias.js';

const OPEN = Date.UTC(2026, 10, 4, 3, 45) / 1000; // 09:15 IST
const rising = (n, from = 23700, step = 2) => Array.from({ length: n }, (_, i) => ({ time: OPEN + i * 60, open: from + i * step, high: from + i * step + 3, low: from + i * step - 3, close: from + i * step + 1 }));

test('with the day: a call needs the index above its open and its average, a put below both, and early in the day it lets trades through', () => {
  const c1 = rising(60);
  const now = OPEN + 60 * 60;
  const stand = dayStand(c1, { now, price: 23820 });
  assert.equal(stand.up, true);
  assert.equal(dayBiasSkip(stand, { on: true }, { side: 'CE' }), null);
  assert.match(dayBiasSkip(stand, { on: true }, { side: 'PE' }), /no put/);
  assert.equal(dayBiasSkip(stand, null, { side: 'PE' }), null, 'off: never says no');
  assert.equal(dayStand(c1.slice(0, 10), { now: OPEN + 10 * 60, price: 23720 }), null, 'before 15 bars there is no verdict');
  assert.deepEqual(dayBiasOf({ withDay: true }), { on: true });
  assert.equal(dayBiasOf({}), null);
});

test('the losing-streak pause rests an entry after that many losses in a row today, and a win in between resets it', () => {
  assert.equal(streakSkip([{ net: -1 }, { net: -2 }], 2) != null, true);
  assert.equal(streakSkip([{ net: -1 }, { net: 5 }], 2), null);
  assert.equal(streakSkip([{ net: -1 }], 2), null);
  assert.equal(streakSkip([{ net: -1 }, { net: -1 }], 0), null, '0 = off');
});

import { tradesFor } from '../src/study/optionsStudy.js';

test('the study honours "with the day only": on a rising day a put signal is skipped and counted, a call is taken', () => {
  const start = Date.UTC(2026, 9, 12, 3, 45) / 1000; // 09:15 IST, a Monday
  let price = 24000;
  const c1 = Array.from({ length: 200 }, (_, i) => {
    const open = price;
    price += 0.5;
    return { time: start + i * 60, open, high: price + 0.5, low: open - 0.5, close: price, volume: 0 };
  });
  const byTime = new Map(c1.map((b, i) => [b.time, i]));
  const at = start + 60 * 60;
  const base = { technique: 'x', note: '', atr: 20, close: c1[60].open };
  const params = { iv: 0.14, lockStart: 1000, lockGap: 250, lotSize: 65, holidays: [], expiryWeekday: 2, withDay: { on: true } };
  const put = tradesFor([{ ...base, side: 'PE', time: at, stop: c1[60].open + 25 }], { c1, byTime, params });
  assert.equal(put.trades.length, 0);
  assert.equal(put.skips.withDay, 1);
  const call = tradesFor([{ ...base, side: 'CE', time: at, stop: c1[60].open - 25 }], { c1, byTime, params });
  assert.equal(call.trades.length, 1);
});

import { prevBiasOf, prevCloseOf, prevBiasSkip } from '../src/options/dayBias.js';

test("with yesterday's close: a call needs the index above yesterday's close, a put below it; on unless switched off", () => {
  const y = Date.UTC(2026, 10, 3, 9, 59) / 1000; // 15:29 IST the day before
  const c1 = [{ time: y - 60, close: 23690 }, { time: y, close: 23700 }, ...rising(30)];
  const now = OPEN + 30 * 60;
  assert.equal(prevCloseOf(c1, now), 23700);
  assert.equal(prevCloseOf(rising(30), now), null, 'no earlier day: no verdict');
  const on = prevBiasOf({});
  assert.deepEqual(on, { on: true }, 'on by default');
  assert.equal(prevBiasOf({ withPrev: false }), null);
  assert.equal(prevBiasSkip(23700, on, { side: 'CE', price: 23750 }), null);
  assert.match(prevBiasSkip(23700, on, { side: 'PE', price: 23750 }), /no put/);
  assert.match(prevBiasSkip(23700, on, { side: 'CE', price: 23650 }), /no call/);
  assert.equal(prevBiasSkip(23700, on, { side: 'PE', price: 23650 }), null);
  assert.equal(prevBiasSkip(null, on, { side: 'PE', price: 23750 }), null, 'yesterday unknown: lets it through');
  assert.equal(prevBiasSkip(23700, null, { side: 'PE', price: 23750 }), null, 'off: never says no');
});

test("the study honours \"with yesterday's close\": above it a put is skipped and counted, a call is taken", () => {
  const start = Date.UTC(2026, 9, 12, 3, 45) / 1000; // 09:15 IST, a Monday
  const yesterday = { time: start - 18 * 3600, open: 23900, high: 23905, low: 23895, close: 23900, volume: 0 };
  let price = 24000;
  const today = Array.from({ length: 120 }, (_, i) => {
    const open = price;
    price += i % 2 ? 0.5 : -0.5;
    return { time: start + i * 60, open, high: open + 1, low: open - 1, close: price, volume: 0 };
  });
  const c1 = [yesterday, ...today];
  const byTime = new Map(c1.map((b, i) => [b.time, i]));
  const at = start + 60 * 60;
  const entry = c1[byTime.get(at)].open;
  const base = { technique: 'x', note: '', atr: 20, close: entry };
  const params = { iv: 0.14, lockStart: 1000, lockGap: 250, lotSize: 65, holidays: [], expiryWeekday: 2, withPrev: { on: true } };
  const put = tradesFor([{ ...base, side: 'PE', time: at, stop: entry + 25 }], { c1, byTime, params });
  assert.equal(put.trades.length, 0);
  assert.equal(put.skips.withPrev, 1);
  const call = tradesFor([{ ...base, side: 'CE', time: at, stop: entry - 25 }], { c1, byTime, params });
  assert.equal(call.trades.length, 1);
});
