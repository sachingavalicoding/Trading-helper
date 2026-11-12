import test from 'node:test';
import assert from 'node:assert/strict';
import { learn, failures, slotCombo, pickName, LEARNER_SLOT } from '../src/learner/learn.js';
import { runOptionsStudy } from '../src/study/optionsStudy.js';
import { runSharesStudy } from '../src/study/sharesStudy.js';
import { normalizeCombos } from '../src/combos/combos.js';

const OPEN = Date.parse('2026-01-05T03:45:00Z') / 1000;
const PARAMS = { iv: 0.14, lockStart: 1000, lockGap: 250, lotSize: 65, holidays: [], expiryWeekday: 2 };
function minutes(nDays, seed = 11) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  let price = 24000;
  for (let d = 0; d < nDays; d++) {
    let drift = 0;
    for (let m = 0; m < 375; m++) {
      if (m % 60 === 0) drift = (rnd() - 0.5) * 0.9;
      const o = price;
      const c = o + drift + (rnd() - 0.5) * 6;
      out.push({ time: OPEN + d * 86400 + m * 60, open: o, high: Math.max(o, c) + rnd() * 2, low: Math.min(o, c) - rnd() * 2, close: c, volume: 0 });
      price = c;
    }
  }
  return out;
}

const m = (trades, net) => ({ trades, net, winRate: 50 });
const row = (train, test) => ({ train, test, all: m(train.trades + test.trades, train.net + test.net) });

// A made-up market: what each list of checks (and each side) made on the older and the newest days.
function fakeMarket(table, { baseline = row(m(0, 0), m(0, 0)), addTo = (set) => null } = {}) {
  const keyOf = (c) => `${[...c.conds].sort().join('+')}|${c.side ?? ''}`;
  return {
    evaluateMany: async (lists) => lists.map((conds) => ({ conds, ...(table[`${[...conds].sort().join('+')}|`] ?? row(m(0, 0), m(0, 0))) })),
    evaluateSets: async (sets) =>
      sets.map((set) => {
        if (!set.length) return row(m(0, 0), m(0, 0));
        const mine = set.filter((c) => c.id === LEARNER_SLOT);
        if (mine.length === set.length) return table[keyOf(mine[0])] ?? row(m(0, 0), m(0, 0));
        return mine.length ? addTo(set) : baseline;
      }),
  };
}

// indicators that make findCombos try pairs of a, b, c (all made money alone with enough trades)
const indicators = ['rsiAbove50', 'macdZero', 'emaStack'].map((key) => ({ key, trades: 30, net: 1000 }));
const have = {};

test('learner: picks on the older days only, and only what also made money on the newest days', async () => {
  const table = {
    'macdZero+rsiAbove50|': row(m(12, 5000), m(6, -300)), // best on the older days, but lost on the newest: refused
    'macdZero+rsiAbove50|CE': row(m(10, 5200), m(5, -100)),
    'macdZero+rsiAbove50|PE': row(m(4, -200), m(2, -50)),
    'emaStack+rsiAbove50|': row(m(14, 3000), m(6, 800)),
    'emaStack+rsiAbove50|CE': row(m(10, 3500), m(5, 900)), // calls only did best on the older days: that side is picked
    'emaStack+rsiAbove50|PE': row(m(4, -500), m(1, -100)),
  };
  const fake = fakeMarket(table);
  // findCombos only lists pairs that made money on both parts; give it both pairs as such so the learner's own check is what refuses one
  const evaluateMany = async (lists) => lists.map((conds) => ({ conds, ...row(m(12, conds.includes('emaStack') ? 3000 : 5000), m(6, 100)) }));
  const r = await learn({ studyDays: 30, trainEnd: 1, indicators, have, evaluateMany, evaluateSets: fake.evaluateSets });
  assert.equal(r.verdict, 'found');
  assert.deepEqual([...r.pick.conds].sort(), ['emaStack', 'rsiAbove50']);
  assert.equal(r.pick.side, 'CE');
  assert.equal(r.pick.sideText, 'calls only');
  assert.equal(r.trainDays, 20);
  assert.equal(r.testDays, 10);
  const refused = r.candidates.find((c) => c.conds.includes('macdZero') && c.conds.includes('rsiAbove50') && c.conds.length === 2);
  assert.ok(refused && !refused.passed && refused.why.some((w) => /newest days/.test(w)));
});

test('learner: says no edge found when nothing passes, and when there are too few days', async () => {
  const none = await learn({ studyDays: 30, trainEnd: 1, indicators, have, evaluateMany: async (lists) => lists.map((conds) => ({ conds, ...row(m(12, 500), m(6, -50)) })), evaluateSets: async (sets) => sets.map(() => row(m(12, 500), m(6, -50))) });
  assert.equal(none.verdict, 'none');
  assert.match(none.text, /No edge found/);
  assert.equal(none.pick, undefined);
  const short = await learn({ studyDays: 6, trainEnd: 1, indicators, have, evaluateMany: async () => [], evaluateSets: async () => [] });
  assert.equal(short.verdict, 'short');
  assert.match(short.text, /Nothing was changed/);
});

test('learner: a pick must add profit to the current combinations on the newest days', async () => {
  const current = normalizeCombos([{ id: 'mine', name: 'Mine', conds: ['emaStack', 'macdZero'] }]);
  const good = row(m(12, 2000), m(6, 400));
  const evaluateSets = async (sets) => sets.map((set) => (set.length === 1 && set[0].id === LEARNER_SLOT ? good : set.length === 1 ? row(m(20, 4000), m(8, 900)) : row(m(25, 4500), m(10, 850))));
  const r = await learn({ studyDays: 30, trainEnd: 1, indicators, have, current, evaluateMany: async (lists) => lists.map((conds) => ({ conds, ...good })), evaluateSets });
  assert.equal(r.verdict, 'none', 'together with the current set it made less on the newest days (850 < 900)');
  assert.ok(r.candidates.every((c) => c.why.some((w) => /add profit/.test(w))));
});

test('learner: a pick that was benched after live losses is not used again', async () => {
  const good = row(m(12, 2000), m(6, 400));
  const previous = { ...slotCombo({ conds: ['rsiAbove50', 'macdZero'] }), on: false, benchedOn: '2026-11-10' };
  const evaluateMany = async (lists) => lists.map((conds) => ({ conds, ...(conds.length === 2 && conds.includes('rsiAbove50') && conds.includes('macdZero') ? good : row(m(12, 100), m(6, -10))) }));
  const evaluateSets = async (sets) => sets.map((set) => (set[0] && [...set[0].conds].sort().join('+') === 'macdZero+rsiAbove50' && !set[0].side ? good : row(m(0, 0), m(0, 0))));
  const r = await learn({ studyDays: 30, trainEnd: 1, indicators, have, previous, evaluateMany, evaluateSets });
  assert.equal(r.verdict, 'none');
  assert.ok(r.previousResult && r.previousResult.why.some((w) => /live losses/.test(w)));
});

test('failures: names each reason in words', () => {
  assert.deepEqual(failures({ alone: row(m(12, 100), m(6, 50)), withSet: null, baseline: null }), []);
  assert.equal(failures({ alone: row(m(3, 100), m(6, 50)) }).length, 1);
  assert.match(failures({ alone: row(m(12, 100), m(2, 50)) })[0], /only 2 trades on the newest days/);
  assert.match(pickName(['rsiAbove50', 'macdZero']), /^Learner: /);
  assert.ok(pickName(Array(8).fill('rsiAbove50')).length <= 60);
  assert.deepEqual(slotCombo({ conds: ['a', 'b'], side: 'PE' }), { id: LEARNER_SLOT, name: 'Learner: a + b', conds: ['a', 'b'], need: 2, window: 3, on: true, side: 'PE' });
});

test('learner inside the options study: the real finders, the live trade rules, and an honest verdict', async () => {
  let seen = null;
  const r = await runOptionsStudy({ nifty1: minutes(24), params: { ...PARAMS, days: 20, lossLimit: 1500, maxLots: 2, live: true, finderOnly: true, learn: async (args) => (seen = await learn({ ...args, kind: 'options' })) } });
  assert.ok(seen && r.learned === seen);
  assert.ok(['found', 'none'].includes(seen.verdict));
  assert.equal(seen.trainDays + seen.testDays, 20);
  for (const c of seen.candidates) {
    assert.ok([null, 'CE', 'PE'].includes(c.side));
    if (c.passed) assert.ok(c.train.net > 0 && c.test.net > 0 && c.test.trades >= 5);
  }
  if (seen.pick) assert.ok(seen.candidates.filter((c) => c.passed).every((c) => c.train.net <= seen.pick.train.net), 'the pick is the best on the older days');
});

test('learner inside the shares study', async () => {
  const history = { AAA: minutes(14, 3), BBB: minutes(14, 5) };
  let seen = null;
  const r = await runSharesStudy({ nifty1: minutes(14, 7), history, params: { days: 12, riskAmount: 200, finderOnly: true, learn: async (args) => (seen = await learn({ ...args, kind: 'shares' })) } });
  assert.ok(seen && r.learned === seen);
  assert.ok(['found', 'none', 'short'].includes(seen.verdict));
});
