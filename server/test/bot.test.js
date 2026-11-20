import test from 'node:test';
import assert from 'node:assert/strict';
import { calcBot, allot, stopAfter, normalizeBot, activeBot, botText, MIN_CALC_TRADES } from '../src/combos/bot.js';
import { normalizeCombos } from '../src/combos/combos.js';
import { simulateTrade } from '../src/study/simulate.js';

const T = [{ at: 300, part: 33 }, { at: 600, part: 33 }, { at: 900, part: 34 }];

test('the parts of a trade are shared out by lots, and the last target sells what is left', () => {
  assert.deepEqual(allot(3, T), [1, 1, 1]);
  assert.deepEqual(allot(2, T), [1, 0, 1]);
  assert.deepEqual(allot(1, T), [0, 1, 0]);
  assert.deepEqual(allot(4, T), [1, 2, 1]);
  assert.deepEqual(allot(6, T), [2, 2, 2]);
  for (const n of [1, 2, 3, 4, 5, 7, 10]) assert.equal(allot(n, T).reduce((a, b) => a + b, 0), n);
});

test('the stop starts at the bot stop, goes to the entry plus charges after the first target, then to the first target', () => {
  const b = { stop: 800, targets: T };
  assert.equal(stopAfter(b, 0, 70), -800);
  assert.equal(stopAfter(b, 1, 70), 70);
  assert.equal(stopAfter(b, 2, 70), 300);
});

test('the levels come from the trades: targets that 7, 5 and 3 in 10 reached, and a stop most winners never went past', () => {
  // 10 trades, 1 lot each: best run-ups 100..1900, winners dipped up to 500
  const trades = Array.from({ length: 10 }, (_, i) => ({ best: 100 + i * 200, worst: i < 4 ? -1500 : -100 - i * 40, net: i < 4 ? -1200 : 500 + i * 50, lots: 1 }));
  const r = calcBot(trades, { cap: 2000 });
  assert.deepEqual(r.targets.map((t) => t.at), [700, 1100, 1300]);
  assert.deepEqual(r.targets.map((t) => t.part), [33, 33, 34]);
  assert.equal(r.stop, 500, 'nine in ten winners stayed above -₹460: rounded up to ₹500');
  assert.equal(r.basis.trades, 10);
  // two-lot trades count per lot
  const two = calcBot(trades.map((t) => ({ best: t.best * 2, worst: t.worst * 2, net: t.net * 2, lots: 2 })), { cap: 2000 });
  assert.deepEqual(two.targets, r.targets);
  // the cap (the loss cut for one lot) wins over a wide dip
  assert.equal(calcBot(trades.map((t) => ({ ...t, worst: t.net > 0 ? -3000 : t.worst })), { cap: 1000 }).stop, 1000);
  // tiny run-ups: the first target is at least ₹300 and they stay ₹150 apart
  const flat = calcBot(Array.from({ length: 10 }, () => ({ best: 50, worst: -100, net: 20 })));
  assert.deepEqual(flat.targets.map((t) => t.at), [300, 450, 600]);
  assert.match(calcBot(trades.slice(0, MIN_CALC_TRADES - 1)).skipped, /at least 8/);
});

test('a bot is kept with its combination and its switch; off means the normal ladder', () => {
  const raw = { name: 'X', conds: ['p_breakout'], bot: { on: true, stop: 900, targets: T, setAt: '2026-11-20T06:00:00Z', prev: null, info: { verdict: 'better' } } };
  const [c] = normalizeCombos([raw]);
  assert.deepEqual(c.bot.targets, T);
  assert.equal(c.bot.prev, null);
  assert.deepEqual(activeBot(c), { stop: 900, targets: T });
  assert.equal(activeBot({ ...c, bot: { ...c.bot, on: false } }), null);
  assert.equal(normalizeBot({ on: true, stop: 900, targets: T.slice(0, 2) }), undefined, 'needs three targets');
  assert.equal(normalizeBot({ on: true, stop: 900, targets: [T[1], T[0], T[2]] }), undefined, 'targets must rise');
  assert.match(botText(activeBot(c)), /33% at \+₹300/);
});

test('the simulation sells parts at the bot targets and moves the stop, and with one lot sells at the middle target', () => {
  const start = Date.UTC(2026, 9, 5, 4, 0) / 1000; // 9:30 IST
  // the index rises 3 points a minute for 40 minutes, then falls back hard
  const c1 = Array.from({ length: 100 }, (_, i) => {
    const p = i < 40 ? 24000 + i * 3 : 24120 - (i - 40) * 6;
    return { time: start + i * 60, open: p, high: p + 1, low: p - 1, close: i < 40 ? p + 3 : p - 6, volume: 0 };
  });
  const byTime = new Map(c1.map((b, i) => [b.time, i]));
  const signal = { side: 'CE', time: c1[1].time, stop: 23900 };
  const params = { lotSize: 65, holidays: [], expiryWeekday: 2, strikeStep: 50, steps: [], lossLimit: 0, fixedLots: 3 };
  const bot = { stop: 900, targets: [{ at: 400, part: 33 }, { at: 800, part: 33 }, { at: 1200, part: 34 }] };
  const plain = simulateTrade({ c1, byTime, signal, params });
  const three = simulateTrade({ c1, byTime, signal: { ...signal, bot }, params });
  assert.equal(three.lots, 3);
  assert.ok(three.bot.hit >= 2, `reached two targets or more: ${JSON.stringify(three.bot)}`);
  assert.deepEqual(three.bot.sold.slice(0, 2).map((s) => [s.lots, s.why]), [[1, 'TARGET1'], [1, 'TARGET2']]);
  assert.ok(three.gross > plain.gross, `kept more than riding it back down: ${three.gross} vs ${plain.gross}`);
  const one = simulateTrade({ c1, byTime, signal: { ...signal, bot }, params: { ...params, fixedLots: 1 } });
  assert.deepEqual(one.bot.sold.map((s) => [s.lots, s.why]), [[1, 'TARGET2']]);
  assert.equal(one.reason, 'TARGET');
  assert.ok(Math.abs(one.gross - 800) < 30, `one lot sold at +₹800: ${one.gross}`);
  // a trade that falls first is sold at the bot stop
  const down = c1.map((b, i) => ({ ...b, open: 24000 - i * 4, high: 24001 - i * 4, low: 23999 - i * 4, close: 24000 - i * 4 - 4 }));
  const lost = simulateTrade({ c1: down, byTime, signal: { ...signal, stop: 23000, bot }, params });
  assert.equal(lost.reason, 'CUT');
  assert.ok(Math.abs(lost.gross + 2700) < 100, `about -₹900 a lot: ${lost.gross}`);
});
