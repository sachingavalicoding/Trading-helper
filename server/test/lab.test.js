import test from 'node:test';
import assert from 'node:assert/strict';
import { runLab, lines } from '../src/lab/lab.js';
import { normalizeCombos } from '../src/combos/combos.js';

const OPEN = Date.UTC(2026, 9, 5, 3, 45) / 1000;
const PARAMS = { iv: 0.14, lockStart: 1000, lockGap: 250, lotSize: 65, holidays: [], expiryWeekday: 2, lossLimit: 1500, maxLots: 2 };
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

const combos = normalizeCombos([{ name: 'Trend and RSI', conds: ['emaStack', 'rsiAbove50'] }]);
const nifty1 = minutes(14);
const run = (extra = {}) => runLab({ nifty1, params: { ...PARAMS, combos }, base: `combo:${combos[0].id}`, days: 10, ...extra });

test('the lab lists every entry of a combination with a summary, an equity line and a ranking of checks to add', () => {
  const r = run();
  assert.equal(r.period.days, 10);
  assert.ok(r.entries.length > 0);
  assert.equal(r.entries.length, r.stats.trades);
  assert.equal(r.stats.equity.length, r.stats.trades);
  assert.ok(r.entries.every((e) => e.status === 'kept' && ['CE', 'PE'].includes(e.side)));
  assert.ok(r.addons.length > 0);
  for (const a of r.addons) assert.ok(!r.base.conds.includes(a.key));
  assert.ok(r.addons.every((a, i) => i === 0 || r.addons[i - 1].gain >= a.gain));
  assert.equal(r.withAdd, null);
});

test('adding a check marks the entries it skips as removed, and each losing entry names checks that would have skipped it', () => {
  const base = run();
  const pick = base.addons.find((a) => a.removed.trades > 0);
  assert.ok(pick, 'some check removes an entry');
  const r = run({ add: [pick.key] });
  const removed = r.entries.filter((e) => e.status === 'removed');
  assert.equal(removed.length, pick.removed.trades);
  assert.equal(r.withAdd.trades, r.entries.filter((e) => e.status !== 'removed').length);
  assert.equal(Math.round(r.withAdd.net - base.stats.net), Math.round(pick.gain));
  const loser = base.entries.find((e) => e.net <= 0 && e.fixes.length);
  assert.ok(loser, 'a losing entry has a fix listed');
  assert.ok(loser.fixes.every((f) => typeof f.label === 'string' && 'winnersLost' in f));
  assert.ok(base.entries.filter((e) => e.net > 0).every((e) => e.fixes.length === 0));
});

test('a pattern can be the starting point, and a missing combination or unknown start is refused', () => {
  const r = runLab({ nifty1, params: { ...PARAMS, combos }, base: 'pattern:breakout', days: 10 });
  assert.equal(r.base.name.length > 0, true);
  assert.throws(() => runLab({ nifty1, params: { ...PARAMS, combos }, base: 'combo:nope', days: 10 }), /not saved/);
  assert.throws(() => runLab({ nifty1, params: { ...PARAMS, combos }, base: 'x', days: 10 }), /Pick a combination/);
  const c = lines(combos);
  assert.equal(c.combos[0].key, `combo:${combos[0].id}`);
  assert.ok(c.patterns.some((p) => p.key === 'pattern:breakout'));
});

test('every trading day of the period is listed with the index move and its entries, and each entry has an exit premium', () => {
  const r = run();
  assert.equal(r.dayList.length, 10);
  assert.ok(r.dayList.every((d) => typeof d.changePts === 'number' && d.realPrices === false));
  assert.equal(r.dayList.reduce((a, d) => a + d.trades, 0), r.entries.length);
  assert.equal(Math.round(r.dayList.reduce((a, d) => a + d.net, 0)), Math.round(r.stats.net));
  assert.ok(r.entries.every((e) => e.exitPremium >= 0));
});

import mongoose from 'mongoose';
import { LabService } from '../src/lab/service.js';
import { INDEXES } from '../src/options/symbols.js';
import { setup, teardown, closeDb, baseConfig } from './helpers.js';

test('the lab service reads the candles once and ranks the checks once, so picking checks is quick', async () => {
  const ctx = await setup();
  let reads = 0;
  const market = { weekdayOf: () => 2, getStudyRange: async (symbol, unit) => { reads += 1; return symbol === INDEXES.NIFTY.symbol && unit === 1 ? nifty1 : []; } };
  const lab = new LabService({ market, config: baseConfig });
  const user = new mongoose.Types.ObjectId();
  const first = await lab.run(user, { base: 'pattern:breakout', days: 10, prices: 'estimated' });
  const readsAfterFirst = reads;
  const pick = first.addons.find((a) => a.removed.trades > 0);
  const second = await lab.run(user, { base: 'pattern:breakout', days: 10, prices: 'estimated', add: [pick.key] });
  assert.equal(reads, readsAfterFirst, 'no candles were read again');
  assert.equal(lab.analyses.size, 1, 'one ranking served both requests');
  assert.deepEqual(second.addons, first.addons);
  assert.equal(second.withAdd.trades, first.entries.length - pick.removed.trades + pick.added.trades);
  await teardown(ctx);
  await closeDb();
});

import { researchLab, analyzeLab } from '../src/lab/lab.js';

test('the lab finds the best stop and profit ladder for a combination, with the older and newer days', async () => {
  const ctx = analyzeLab({ nifty1, params: { ...PARAMS, combos }, base: `combo:${combos[0].id}`, days: 14 });
  const r = await researchLab(ctx, []);
  assert.ok(!r.skipped, 'enough entries to research');
  assert.ok(r.stops.length > 5 && r.exits.length > 5);
  assert.ok(r.base.trades > 0);
  assert.ok(r.exits.some((x) => x.apply?.comboExits), 'a profit row can be applied to the combination alone');
  const tiny = analyzeLab({ nifty1: minutes(1), params: { ...PARAMS, combos }, base: `combo:${combos[0].id}`, days: 3 });
  assert.match((await researchLab(tiny, [])).skipped ?? '', /Fewer than 5/);
});
