import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findWinners } from '../src/study/pairFinder.js';
import { CONDITIONS } from '../src/combos/conditions.js';
import { formingBar, followsSlot, Holds } from '../src/options/second.js';

const keys = CONDITIONS.filter((c) => c.needs !== 'news').slice(0, 4).map((c) => c.key);
const have = {};
const row = (key, trades, winRate, net) => ({ key, trades, winRate, net });

test('win finder lists only combinations at or over the win rate with enough trades and a profit', async () => {
  const indicators = keys.map((k, i) => row(k, 10, 60 + i, 100));
  const evaluateMany = async (lists) =>
    lists.map((conds) => {
      // pairs of the first two checks win 80% on 6 trades; a single wins 90% on 2 trades (too few); a triple wins 75% but loses money
      const pair = conds.length === 2 && conds.includes(keys[0]) && conds.includes(keys[1]);
      const few = conds.length === 1 && conds[0] === keys[2];
      const losing = conds.length === 3;
      const all = pair ? { trades: 6, winRate: 80, net: 900, calls: {}, puts: {} } : few ? { trades: 2, winRate: 90, net: 500, calls: {}, puts: {} } : losing ? { trades: 8, winRate: 75, net: -300, calls: {}, puts: {} } : { trades: 8, winRate: 40, net: 50, calls: {}, puts: {} };
      return { conds, train: all, test: all, all };
    });
  const r = await findWinners({ indicators, have: new Proxy({}, { get: () => true }), studyDays: 5, evaluateMany });
  assert.equal(r.found.length, 1);
  assert.deepEqual(r.found[0].conds.slice().sort(), [keys[0], keys[1]].sort());
  assert.equal(r.found[0].trades, 6);
  assert.equal(r.minWin, 70);
});

test('forming bar uses the live price as close and extends high and low', () => {
  const c1 = [
    { time: 300, open: 10, high: 12, low: 9, close: 11, volume: 5 },
    { time: 360, open: 11, high: 13, low: 10, close: 12, volume: 4 },
  ];
  const b = formingBar(c1, 14, 400);
  assert.deepEqual([b.time, b.open, b.high, b.low, b.close, b.volume], [300, 10, 14, 9, 14, 9]);
  assert.equal(followsSlot([{ time: 0 }], 310), true);
  assert.equal(followsSlot([{ time: 0 }], 610), false);
});

test('a signal must stay true for the held seconds', () => {
  const h = new Holds();
  assert.equal(h.held('a', 1000, 3), false);
  assert.equal(h.held('a', 3000, 3), false);
  assert.equal(h.held('a', 4000, 3), true);
  h.prune(new Set());
  assert.equal(h.held('a', 5000, 3), false);
  assert.equal(h.held('b', 5000, 0), true);
});
