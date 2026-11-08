import test from 'node:test';
import assert from 'node:assert/strict';
import { runSharesLab, liveRun, withOrder, shareLines } from '../src/lab/sharesLab.js';
import { normalizeCombos, normalizeOrder } from '../src/combos/combos.js';
import { comboMoney, shareIdeas, shareChart, bars5Of } from '../src/combos/shares.js';
import { sizeOf, netResult } from '../src/scanner/backtest.js';
import { withOrderOptions } from '../src/lab/orders.js';

const OPEN = Date.UTC(2026, 9, 5, 3, 45) / 1000;
function minutes(nDays, seed = 11, start = 1000, vol = 1) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  let price = start;
  for (let d = 0; d < nDays; d++) {
    let drift = 0;
    for (let m = 0; m < 375; m++) {
      if (m % 60 === 0) drift = (rnd() - 0.5) * 0.4 * vol;
      const o = price;
      const c = o + drift + (rnd() - 0.5) * 1.5 * vol;
      out.push({ time: OPEN + d * 86400 + m * 60, open: o, high: Math.max(o, c) + rnd() * 0.5 * vol, low: Math.min(o, c) - rnd() * 0.5 * vol, close: c, volume: 1000 + Math.round(rnd() * 5000) });
      price = c;
    }
  }
  return out;
}

const nifty1 = minutes(14, 7, 24000, 6);
const history = Object.fromEntries(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map((sym, k) => [sym, minutes(14, 101 + k * 13, 500 + k * 300, 0.6 + k * 0.2)]));
const combos = normalizeCombos([{ name: 'Trend and RSI', conds: ['emaStack', 'rsiAbove50'] }]);
const PARAMS = { combos, riskAmount: 500, steps: [{ at: 600, keep: 300 }], target: 0, exitMin: 915, slippagePct: 0.05, maxAmount: 200000, maxShares: 0, maxOpen: 3, dailyLoss: 0 };
const run = (extra = {}) => runSharesLab({ nifty1, history, params: PARAMS, base: `combo:${combos[0].id}`, days: 10, ...extra });

test('the shares lab trades a share combination on every stock, with the live limits, an entry list and a ranking of checks', () => {
  const r = run();
  assert.equal(r.segment, 'shares');
  assert.equal(r.period.days, 10);
  assert.ok(r.entries.length > 0, 'some entries');
  assert.equal(r.entries.length, r.stats.trades);
  assert.ok(r.entries.every((e) => ['CE', 'PE'].includes(e.side) && e.qty > 0 && e.exitTime > e.entryTime && history[e.symbol]));
  assert.ok(r.entries.every((e) => e.amount <= PARAMS.maxAmount + 1));
  // never two trades open together on one stock, never more than maxOpen at once
  for (const e of r.entries) {
    const open = r.entries.filter((x) => x.entryTime <= e.entryTime && x.exitTime > e.entryTime);
    assert.ok(open.length <= PARAMS.maxOpen);
    assert.equal(open.filter((x) => x.symbol === e.symbol).length, 1);
  }
  assert.ok(r.stats.byStock.length > 0);
  assert.equal(r.orders.used.riskAmount, 500);
  assert.equal(r.orders.edited, false);
  assert.ok(r.addons.every((a, i) => i === 0 || r.addons[i - 1].gain >= a.gain));
  assert.equal(r.dayList.length, 10);
});

test('adding a check skips entries, and losing entries name checks that would have skipped them', () => {
  const base = run();
  const pick = base.addons.find((a) => a.removed.trades > 0);
  assert.ok(pick);
  const r = run({ add: [pick.key] });
  assert.equal(r.entries.filter((e) => e.status === 'removed').length, pick.removed.trades);
  assert.equal(Math.round(r.withAdd.net - base.stats.net), Math.round(pick.gain));
  assert.ok(base.entries.filter((e) => e.net > 0).every((e) => e.fixes.length === 0));
});

test('order settings tried in the lab change the trades: risk, money cap, stop %, target, exit time and side', () => {
  const base = run();
  const r = run({ edit: { side: 'CE', order: { risk: 1000, stopPct: 1, target: 400, exitMin: 14 * 60 }, steps: null } });
  assert.equal(r.orders.edited, true);
  assert.ok(r.entries.length > 0);
  assert.ok(r.entries.every((e) => e.side === 'CE'), 'buys only');
  assert.ok(r.entries.every((e) => Math.abs(e.stopLoss - e.entry) / e.entry > 0.0095 && Math.abs(e.stopLoss - e.entry) / e.entry < 0.0105), 'stop 1% away');
  assert.ok(r.entries.every((e) => e.reason !== 'LOCK'), 'a target replaces the ladder');
  assert.ok(r.entries.every((e) => new Date(e.entryTime * 1000 + 19800000).getUTCHours() * 60 + new Date(e.entryTime * 1000 + 19800000).getUTCMinutes() <= 14 * 60), 'no entry after its own exit time');
  assert.ok(r.entries.some((e) => e.reason === 'TARGET') || r.entries.length < base.entries.length);
  const capped = run({ edit: { order: { maxAmount: 5000 } } });
  assert.ok(capped.entries.every((e) => e.amount <= 5000));
});

test('a single check can be the start, and an unknown start is refused', () => {
  const r = run({ base: 'check:rsiAbove50' });
  assert.ok(r.base.name);
  assert.throws(() => run({ base: 'combo:nope' }), /not saved/);
  assert.throws(() => run({ base: 'check:nope' }), /cannot be tested/);
  const l = shareLines(combos);
  assert.equal(l.combos[0].key, `combo:${combos[0].id}`);
  assert.ok(l.checks.length > 50);
});

test('liveRun keeps one trade per stock and at most maxOpen, and stops for the day at the loss limit', () => {
  const t = (symbol, entryTime, exitTime, net) => ({ symbol, entryTime, exitTime, net });
  const r = liveRun([t('A', 0, 100, -50), t('A', 50, 150, 10), t('B', 60, 70, 5), t('C', 61, 90, 5), t('D', 200, 300, 5)], { maxOpen: 2, dailyLoss: 40 });
  assert.deepEqual(r.trades.map((x) => `${x.symbol}${x.entryTime}`), ['A0', 'B60']);
  assert.equal(r.blocked.sameStock, 1);
  assert.equal(r.blocked.busy, 1);
  assert.equal(r.blocked.dailyLoss, 1);
});

test('a share combination keeps its own order settings when saved, and its money rules replace the Account ones', () => {
  const [c] = normalizeCombos([{ name: 'X', conds: ['emaStack'], order: { risk: 800, maxAmount: 50000, stopPct: 0.1, target: 0, exitMin: 2000 }, exits: { steps: [{ at: 500, keep: 200 }] } }]);
  assert.deepEqual(c.order, { risk: 800, maxAmount: 50000, stopPct: 0.3, exitMin: 915 });
  const m = comboMoney(c, { riskAmount: 200, maxAmount: 30000, steps: [{ at: 300, keep: 100 }], target: 0, exitMin: 900 });
  assert.equal(m.riskAmount, 800);
  assert.equal(m.maxAmount, 50000);
  assert.deepEqual(m.steps, [{ at: 500, keep: 200 }]);
  assert.equal(m.exitMin, 915);
  assert.equal(comboMoney({ ...c, order: { target: 700 } }, m).target, 700);
  assert.equal(normalizeOrder({ risk: 0 }), undefined);
  assert.equal(withOrder(c, { order: null }).order, undefined);
  assert.deepEqual(withOrder(c, { steps: [] }).exits, { steps: [] });
});

test('sizeOf respects the money cap and a share cap; netResult keeps a size the replay already chose', () => {
  const idea = { side: 'BUY', entry: 1000, stopLoss: 990 };
  assert.equal(sizeOf(idea, { riskAmount: 1000, slippagePct: 0 }), 100);
  assert.equal(sizeOf(idea, { riskAmount: 1000, slippagePct: 0, maxAmount: 30000 }), 30);
  assert.equal(sizeOf(idea, { riskAmount: 1000, slippagePct: 0, maxShares: 7 }), 7);
  assert.equal(netResult({ ...idea, status: 'TARGET_HIT', exitPrice: 1010, sizedQty: 5 }, { riskAmount: 1000, slippagePct: 0 }).qty, 5);
});

test('an options combination can be tried with other order settings, cleaned like a save', () => {
  const [c] = normalizeCombos([{ name: 'Opt', conds: ['emaStack'] }]);
  const e = withOrderOptions(c, { side: 'PE', stopMode: 'fixed', stopPoints: 40, exits: { steps: [{ at: 1000, keep: 500 }], breakEven: 20 } });
  assert.equal(e.id, c.id);
  assert.equal(e.side, 'PE');
  assert.equal(e.stopMode, 'fixed');
  assert.equal(e.stopPoints, 40);
  assert.deepEqual(e.exits, { steps: [{ at: 1000, keep: 500 }], breakEven: 20 });
  const back = withOrderOptions(e, { side: null, stopMode: null, exits: null });
  assert.equal(back.side, undefined);
  assert.equal(back.stopMode, undefined);
  assert.equal(back.exits, undefined);
});

test('shareIdeas uses a combination\'s own stop %', () => {
  const c1 = history.CCC;
  const chart = shareChart(bars5Of(c1));
  const [c] = normalizeCombos([{ name: 'S', conds: ['rsiAbove50'], order: { stopPct: 2 } }]);
  const ideas = shareIdeas(chart, c, { symbol: 'CCC' });
  assert.ok(ideas.length);
  for (const i of ideas) assert.ok(Math.abs(Math.abs(i.entry - i.stopLoss) / i.entry - 0.02) < 0.001);
});
