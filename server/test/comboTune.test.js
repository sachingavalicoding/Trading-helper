import test from 'node:test';
import assert from 'node:assert/strict';
import { tuneCombo, comboMoves, excursions, excursionNotes, pct, strip, MAX_COMBO_CHANGES } from '../src/learner/comboTune.js';
import { consistent, splitDays, roomLadder, LADDERS, FILTERS } from '../src/learner/tune.js';
import { normalizeExits, normalizeCombos } from '../src/combos/combos.js';
import { withParts } from '../src/learner/learnService.js';
import { simulateTrade } from '../src/study/simulate.js';

const keys = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));
const t0 = (d) => Date.parse(`${d}T05:00:00Z`) / 1000;
const trade = (d, net, best = Math.max(net, 0), worst = Math.min(net, 0)) => ({ entryTime: t0(d), net, best, worst });
const dayOf = (t) => new Date(t.entryTime * 1000).toISOString().slice(0, 10);
const BASE = { combos: [], patternEntries: true, patterns: ['breakout'], maxTrades: 3, dailyLossPct: 20, lossLimit: 3000, lossStreak: 0, steps: [{ at: 3000, keep: 2250 }], stopRule: { mode: 'chart' }, trail: null, breakEven: 0, entryFrom: 555, entryTo: 915 };
const COMBO = { id: 'c', name: 'C', conds: ['p_breakout'], need: 1, window: 3, on: true };

test('a loss cut is kept in the combination, sells the trade at that loss, and 0 means none', () => {
  assert.deepEqual(normalizeExits({ cut: 1000 }), { cut: 1000 });
  assert.equal(normalizeExits({ cut: 0 }), undefined);
  assert.equal(normalizeExits({ cut: 50 }), undefined, 'too small to be a real cut');
  assert.equal(normalizeCombos([{ ...COMBO, exits: { cut: 1500, steps: roomLadder(750, 50) } }])[0].exits.cut, 1500);
  // a put bought on a steady rise: without a cut it rides to the chart stop, with one it is sold at the cut
  const start = Date.UTC(2026, 9, 5, 3, 45) / 1000;
  const c1 = Array.from({ length: 120 }, (_, i) => ({ time: start + i * 60, open: 24000 + i * 2, high: 24001 + i * 2, low: 23999 + i * 2, close: 24000 + i * 2 + 2, volume: 0 }));
  const byTime = new Map(c1.map((b, i) => [b.time, i]));
  const signal = { side: 'PE', time: c1[1].time, stop: 24300 };
  const params = { lotSize: 65, holidays: [], expiryWeekday: 2, strikeStep: 50, steps: [], lossLimit: 0 };
  const plain = simulateTrade({ c1, byTime, signal, params });
  const cut = simulateTrade({ c1, byTime, signal: { ...signal, exits: { cut: 500 } }, params });
  assert.equal(cut.reason, 'CUT');
  assert.ok(cut.gross >= -560 && cut.gross <= -500, `sold near the cut: ${cut.gross}`);
  assert.ok(plain.gross < cut.gross, 'the cut lost less than riding it');
});

test('the excursions say where trades never came back and where winners turned to losses', () => {
  const days = keys(6);
  const trades = [trade(days[0], 900, 1000, -300), trade(days[1], 800, 1200, -400), trade(days[2], 700, 900, -200), trade(days[3], -2000, 100, -2000), trade(days[4], -1800, 50, -2100), trade(days[5], -500, 1500, -600)];
  const ex = excursions(trades);
  const at1000 = ex.down.find((d) => d.at === 1000);
  assert.deepEqual([at1000.trades, at1000.cameBack], [2, 0]);
  assert.equal(ex.wins, 3);
  assert.equal(pct([1, 2, 3, 4, 5], 0.5), 3);
  const notes = excursionNotes(ex).join(' ');
  assert.match(notes, /ended as a loss/);
  assert.match(notes, /winners never went lower/);
});

test('the changes for one combination include side, yesterday levels, small ladders, a cut from its own trades and the last suggestion', () => {
  const ex = { trades: 10, wins: 6, down: [{ at: 1000, trades: 3, cameBack: 0 }], up: [], winnersDip: 640, runUp: 900, losersRanUp: 2 };
  const prev = { ...COMBO, side: 'CE', exits: { cut: 1000 } };
  const moves = comboMoves(COMBO, { labelOf: (k) => k, usable: () => true, ex, previous: prev });
  const labels = moves.map((m) => m.label);
  assert.equal(moves[0].key, 'previous', 'the last suggestion is tried first');
  assert.ok(labels.includes('calls only') && labels.includes('puts only'));
  assert.ok(labels.includes('add aboveYHigh') && labels.includes('add aboveYClose'));
  assert.ok(labels.some((l) => l.includes('at +₹750 keep ₹700')));
  assert.ok(labels.includes('own loss cut: sell at -₹800'), 'just beyond where 9 in 10 winners went');
  assert.ok(labels.includes('own loss cut: sell at -₹1,000'));
  assert.ok(FILTERS.includes('aboveYHigh') && LADDERS.some((l) => l.key === 'r750'));
  const applied = moves.find((m) => m.label === 'own loss cut: sell at -₹1,000').apply(COMBO);
  assert.deepEqual(applied.exits, { cut: 1000 });
  assert.deepEqual(strip(moves[0].apply(COMBO)), { side: 'CE', also: [], exits: { cut: 1000 } });
});

test('a change that wins only on part of the learning days is not consistent', () => {
  const learn = keys(9);
  const old = learn.map((d) => trade(d, 100));
  const lucky = learn.map((d, i) => trade(d, i === 0 ? 5000 : -50));
  const steadyBetter = learn.map((d) => trade(d, 200));
  assert.equal(consistent(lucky, old, learn, dayOf), false);
  assert.equal(consistent(steadyBetter, old, learn, dayOf), true);
});

/** A fake replay of one combination: a cut at 1,000 turns its big losers into small ones, calls-only drops its losing puts. */
function fake(days, { holds = true } = {}) {
  const hidden = new Set(splitDays(days).hidden);
  return async (s) => {
    const c = s.combos[0];
    assert.equal(s.patternEntries, false, 'tuned on its own');
    assert.equal(s.combos.length, 1);
    const cut = c.exits?.cut;
    return days.flatMap((d) => {
      const bigLoss = cut && cut <= 1500 && (holds || !hidden.has(d)) ? -cut : -2500;
      return [trade(d, 800, 1000, -300), trade(d, bigLoss, 50, -2500)];
    });
  };
}

test('one combination: a loss cut learned on the older days that also holds on the hidden days passes, with notes from its trades', async () => {
  const days = keys(20);
  const r = await tuneCombo({ combo: COMBO, base: BASE, days, evaluate: fake(days), dayOf });
  assert.equal(r.verdict, 'passed', r.text);
  assert.ok(r.changes.length >= 1 && r.changes.length <= MAX_COMBO_CHANGES);
  assert.ok(r.proposal.exits?.cut > 0 && r.proposal.exits.cut <= 1500);
  assert.ok(r.hidden.new.net > r.hidden.old.net);
  assert.ok(r.notes.length > 0);
});

test('one combination: a change that does not hold on the hidden days fails, and too few trades are not tuned', async () => {
  const days = keys(20);
  const r = await tuneCombo({ combo: COMBO, base: BASE, days, evaluate: fake(days, { holds: false }), dayOf });
  assert.equal(r.verdict, 'failed');
  const few = await tuneCombo({ combo: COMBO, base: BASE, days, evaluate: async () => [trade(days[0], 100)], dayOf });
  assert.equal(few.verdict, 'few');
});

test('applying puts in the side, extra indicators and exits, and empty parts are taken away', () => {
  const c = { ...COMBO, side: 'PE', also: ['rsiAbove50'], exits: { cut: 900 } };
  assert.deepEqual(withParts(c, { side: 'CE', also: [], exits: { steps: [{ at: 750, keep: 700 }] } }), { ...COMBO, side: 'CE', exits: { steps: [{ at: 750, keep: 700 }] } });
  assert.deepEqual(withParts(c, { side: null, also: [], exits: null }), COMBO);
});

test('a loss cut for all trades sells any trade at that loss, and a combination\'s own cut wins over it', () => {
  const start = Date.UTC(2026, 9, 5, 3, 45) / 1000;
  const c1 = Array.from({ length: 120 }, (_, i) => ({ time: start + i * 60, open: 24000 + i * 2, high: 24001 + i * 2, low: 23999 + i * 2, close: 24000 + i * 2 + 2, volume: 0 }));
  const byTime = new Map(c1.map((b, i) => [b.time, i]));
  const signal = { side: 'PE', time: c1[1].time, stop: 24300 };
  const params = { lotSize: 65, holidays: [], expiryWeekday: 2, strikeStep: 50, steps: [], lossLimit: 0, cut: 500 };
  const all = simulateTrade({ c1, byTime, signal, params });
  assert.equal(all.reason, 'CUT');
  assert.ok(all.gross >= -560 && all.gross <= -500, `sold near the cut for all: ${all.gross}`);
  const own = simulateTrade({ c1, byTime, signal: { ...signal, exits: { cut: 800 } }, params });
  assert.ok(own.gross < all.gross && own.gross >= -900, `own cut wins: ${own.gross}`);
});
