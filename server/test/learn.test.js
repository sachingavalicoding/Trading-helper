import test from 'node:test';
import assert from 'node:assert/strict';
import { maxPainOf, percentileOf, optionSeries, optionView, greeksOf } from '../src/combos/optionData.js';
import { buildChart, CONDITION_BY_KEY, usable } from '../src/combos/conditions.js';
import { comboSignals, normalizeCombos } from '../src/combos/combos.js';
import { PriceBook } from '../src/study/priceBook.js';
import { bsPrice } from '../src/options/pricing.js';
import { yearsToExpiry } from '../src/options/symbols.js';
import { aggregateCandles } from '../src/market/providers/BaseProvider.js';
import { splitDays, steady, tune, judge, movesFor, marginOf, MIN_DAYS, MAX_CHANGES } from '../src/learner/tune.js';
import { learnContext, dayKey, paramsFor } from '../src/learner/learnRun.js';
import { settingsOf, savePatch, fingerprint, LearnService } from '../src/learner/learnService.js';
import { tuneCombo } from '../src/learner/comboTune.js';
import { LiveChain, combosNeedChain } from '../src/options/liveChain.js';
import { LearnerState, OptionSettings, TradeDefaults } from '../src/models/index.js';

const OPEN = Date.UTC(2026, 9, 5, 3, 45) / 1000; // Mon 5 Oct 2026, 09:15 IST
const PARAMS = { iv: 0.14, lockStart: 1000, lockGap: 250, lotSize: 65, holidays: [], expiryWeekday: 2, lossLimit: 1500, maxLots: 2, strikeStep: 50 };

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

/** A saved chain for every day of `nifty1`: strikes round the money, premiums from the model at `iv`, put OI growing when `putsWin`. */
function bookFor(nifty1, { iv = 0.15, putsWin = true, days = null } = {}) {
  const byDay = new Map();
  for (const c of nifty1) {
    const d = dayKey(c.time);
    if (days && !days.includes(d)) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(c);
  }
  const list = [];
  for (const [day, bars] of byDay) {
    const expiry = new Date(Date.parse(`${day}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    const mid = Math.round(bars[0].open / 50) * 50;
    for (let k = -8; k <= 8; k++) {
      const strike = mid + k * 50;
      for (const type of ['CE', 'PE']) {
        const candles = bars.map((b, n) => {
          const t = yearsToExpiry(expiry, new Date(b.time * 1000));
          const p = bsPrice({ type, spot: b.close, strike, t, iv });
          const grow = (type === 'PE') === putsWin ? 2 * n : 0;
          return { time: b.time, open: p, high: p, low: p, close: p, oi: 10000 + grow + Math.abs(k) * 100 };
        });
        list.push({ day, expiry, strike, type, candles });
      }
    }
  }
  return PriceBook.fromContracts(list);
}

// ---------- the option-chain series ----------

test('max pain is the strike where buyers lose the most, and the IV percentile ranks against earlier values only', () => {
  assert.equal(maxPainOf([{ strike: 100, call: 0, put: 50 }, { strike: 110, call: 10, put: 10 }, { strike: 120, call: 50, put: 0 }]), 110);
  assert.equal(maxPainOf([{ strike: 100, call: 0, put: 0 }]), null);
  assert.equal(percentileOf([1, 2, 3, 4], 3.5, 4), 75);
  assert.equal(percentileOf([1, 2], 3), null, 'too few values');
  const near = greeksOf({ type: 'CE', spot: 24000, strike: 24000, t: 1 / 365, iv: 0.15 });
  const far = greeksOf({ type: 'CE', spot: 24000, strike: 24000, t: 20 / 365, iv: 0.15 });
  assert.ok(near.delta > 0.45 && near.delta < 0.6);
  assert.ok(near.thetaPct > far.thetaPct, 'a day costs more of the premium close to expiry');
});

test('the series reads PCR, OI change, max pain, IV and greeks at each 5-minute close, and a put sees them turned round', () => {
  const nifty1 = minutes(8);
  const bars5 = aggregateCandles(nifty1, '5m');
  const s = optionSeries(bars5, bookFor(nifty1, { putsWin: true }));
  assert.equal(s.days, 8);
  const i = bars5.length - 10;
  assert.ok(s.pcr[i] > 1, 'put OI grew all day, so PCR is over 1');
  assert.ok(s.putChg[i] > s.callChg[i]);
  assert.ok(Math.abs(s.atmIv[i] - 0.15) < 0.01, `IV ${s.atmIv[i]}`);
  assert.ok(s.ivPct[i] != null, 'later days have a percentile');
  assert.equal(s.ivPct[0], null, 'the first day has nothing to compare with');
  assert.ok(s.greeks.CE.delta[i] > 0.3 && s.greeks.PE.delta[i] > 0.3);
  const put = optionView(s, -1);
  assert.ok(Math.abs(put.pcr[i] - 1 / s.pcr[i]) < 1e-9);
  assert.ok(put.oiEdge[i] < 0 && optionView(s, 1).oiEdge[i] > 0);
  assert.equal(put.maxPain[i], -s.maxPain[i]);
  assert.equal(optionSeries(bars5, null), null);
});

test('options checks need the chain: unusable without it, and the call and put twins read opposite sides of it', () => {
  const nifty1 = minutes(8);
  const bars5 = aggregateCandles(nifty1, '5m');
  const bare = buildChart(bars5);
  assert.equal(bare.have.options, false);
  assert.equal(usable(CONDITION_BY_KEY.get('pcrAbove1'), bare.have), false);
  const combo = normalizeCombos([{ name: 'PCR', conds: ['pcrAbove1', 'oiBacks'] }])[0];
  assert.deepEqual(comboSignals(bare, combo), []);
  const chart = buildChart(bars5, { options: optionSeries(bars5, bookFor(nifty1, { putsWin: true })) });
  assert.equal(chart.have.options, true);
  const sides = new Set(comboSignals(chart, combo).map((x) => x.side));
  assert.deepEqual([...sides], ['CE'], 'puts written all day: only calls pass the PCR check');
  for (const k of ['pcrAbove1', 'pcrAbove12', 'pcrRising', 'oiBacks', 'oiFresh', 'belowMaxPain', 'aboveMaxPain', 'ivLow', 'ivNotHigh', 'ivRising', 'deltaNearMoney', 'deltaStrong', 'thetaLow', 'thetaVeryLow']) {
    assert.equal(CONDITION_BY_KEY.get(k)?.needs, 'options', k);
    assert.equal(CONDITION_BY_KEY.get(k).group, 'Options', k);
  }
  for (const k of ['rsiAbove60', 'macdBothUp', 'ema5Over13', 'vwapNear', 'bbPctB', 'atrCalm', 'supertrendSlowUp', 'adx30Up']) assert.ok(CONDITION_BY_KEY.has(k), k);
});

// ---------- the learner's judgement ----------

const keys = (n) => Array.from({ length: n }, (_, k) => `2026-10-${String(k + 1).padStart(2, '0')}`);
const trade = (day, net) => ({ day, net, entryTime: 0 });
const dayOf = (t) => t.day;

test('the newest quarter of the days is hidden, at least 3, and too few days learn nothing', () => {
  assert.equal(splitDays(keys(MIN_DAYS - 1)), null);
  const s = splitDays(keys(20));
  assert.equal(s.hidden.length, 5);
  assert.deepEqual(s.hidden, keys(20).slice(15));
  assert.equal(splitDays(keys(9)).hidden.length, 3);
  assert.equal(splitDays(keys(30)).hidden.length, 8);
});

test('steady profit ranks fewer and smaller bad days above the same total, and rewards a better win/loss ratio', () => {
  const days = keys(4);
  const steadyOne = steady([trade(days[0], 500), trade(days[1], 500), trade(days[2], 500), trade(days[3], -300)], days, dayOf);
  const swingy = steady([trade(days[0], 3000), trade(days[1], -900), trade(days[2], -900), trade(days[3], -0)], days, dayOf);
  assert.equal(steadyOne.net, 1200);
  assert.equal(swingy.net, 1200);
  assert.ok(steadyOne.score > swingy.score, `${steadyOne.score} > ${swingy.score}`);
  assert.equal(steadyOne.badDays, 1);
  assert.equal(swingy.badDays, 2);
  assert.equal(steadyOne.worstDay, -300);
  const goodRatio = steady([trade(days[0], 600), trade(days[1], -200)], days, dayOf);
  const poorRatio = steady([trade(days[0], 1000), trade(days[1], -600)], days, dayOf);
  assert.equal(goodRatio.net, poorRatio.net);
  assert.ok(goodRatio.payoff > poorRatio.payoff && goodRatio.score > poorRatio.score);
  assert.equal(steady([], days, dayOf).score, 0);
  assert.ok(marginOf(0) >= 25 && marginOf(10000) === 500);
});

const BASE = { combos: [{ id: 'a', name: 'A', conds: ['rsiAbove50'], need: 1, window: 3, on: true }], patternEntries: false, patterns: [], maxTrades: 3, dailyLossPct: 10, lossLimit: 1500, lossStreak: 2, steps: [{ at: 1000, keep: 750 }], stopRule: { mode: 'chart' }, trail: null, breakEven: 0, entryFrom: 555, entryTo: 915 };

/** A fake replay: every day 2 trades; the trades a day decide the result, so the learner has one thing to find. */
function fakeEvaluate(days, { goodOnHidden }) {
  const hidden = new Set(splitDays(days).hidden);
  return async (s) =>
    days.flatMap((d) => {
      const better = s.maxTrades === 1;
      if (!better) return [trade(d, 400), trade(d, -500)];
      return hidden.has(d) && !goodOnHidden ? [trade(d, -300)] : [trade(d, 400), trade(d, 50)];
    });
}

test('a change that also does better on the hidden days passes, with old against new for the last 5, 10 and 15 days', async () => {
  const days = keys(20);
  const r = await tune({ days, current: BASE, evaluate: fakeEvaluate(days, { goodOnHidden: true }), dayOf, usable: () => true });
  assert.equal(r.verdict, 'passed');
  assert.ok(r.changes.some((c) => c.key === 'maxTrades' && c.to === '1'));
  assert.ok(r.changes.length <= MAX_CHANGES);
  assert.equal(r.proposal.maxTrades, 1);
  assert.equal(r.split.hiddenDays, 5);
  assert.deepEqual(r.windows.map((w) => [w.days, w.hidden]), [[5, 5], [10, 5], [15, 5]]);
  assert.ok(r.hidden.new.net > r.hidden.old.net && r.hidden.new.badDays <= r.hidden.old.badDays);
  assert.ok(r.checks.every((c) => c.ok));
});

test('a change that only fits the learning days fails on the hidden days', async () => {
  const days = keys(20);
  const r = await tune({ days, current: BASE, evaluate: fakeEvaluate(days, { goodOnHidden: false }), dayOf, usable: () => true });
  assert.equal(r.verdict, 'failed');
  assert.match(r.text, /Apply is blocked/);
  assert.ok(r.checks.some((c) => !c.ok && c.key === 'profit'));
  assert.equal(r.proposal.maxTrades, 1, 'the proposal is still kept, for Apply anyway');
});

test('nothing better found keeps the settings; too few days stops early', async () => {
  const days = keys(12);
  const flat = await tune({ days, current: BASE, evaluate: async () => days.flatMap((d) => [trade(d, 100), trade(d, -50)]), dayOf, usable: () => true });
  assert.equal(flat.verdict, 'same');
  assert.equal(flat.changes.length, 0);
  const short = await tune({ days: keys(5), current: BASE, evaluate: async () => [], dayOf });
  assert.equal(short.verdict, 'short');
  assert.equal(judge(steady([], keys(3), dayOf), steady([], keys(3), dayOf)).find((c) => c.key === 'trades').ok, false);
});

test('the changes it tries cover combinations, indicators, limits, the stop, the profit ladder and the entry hours', () => {
  const moves = movesFor({ ...BASE, combos: [...BASE.combos, { id: 'b', name: 'B', conds: ['macdAbove'], on: false }] }, { labelOf: (k) => k, usable: (k) => k !== 'pcrAbove1', patterns: [{ key: 'breakout', label: 'Breakout' }] });
  const groups = new Set(moves.map((m) => m.group));
  for (const g of ['Combinations', 'Indicators', 'Limits', 'Stop loss', 'Profit ladder', 'Entry hours']) assert.ok(groups.has(g), g);
  assert.ok(moves.some((m) => m.label === 'Switch on B'));
  assert.ok(moves.some((m) => m.label === 'A: calls only'));
  assert.ok(moves.some((m) => m.label.includes('add ivLow')));
  assert.ok(!moves.some((m) => m.label === 'A: add pcrAbove1'), 'a check the data cannot read is not tried');
  assert.ok(moves.some((m) => m.key === 'new:p_breakout'));
  const added = moves.find((m) => m.label === 'A: add rsiAbove60').apply(BASE);
  assert.deepEqual(added.combos[0].also, ['rsiAbove60']);
  assert.equal(BASE.combos[0].also, undefined, 'the settings tried are copies');
});

// ---------- the replay and the saved settings ----------

test('the replay runs the whole setup on real saved premiums, and options checks can be tried on those days', async () => {
  const nifty1 = minutes(16);
  const days = [...new Set(nifty1.map((b) => dayKey(b.time)))].slice(-12);
  const book = bookFor(nifty1, { days });
  const ctx = learnContext({ nifty1, book, params: { ...PARAMS, prices: book }, days, budget: 60000 });
  assert.equal(ctx.hasOptions, true);
  assert.equal(ctx.usable('pcrAbove1'), true);
  assert.equal(ctx.usable('aboveVwap'), false, 'no 50-stock volume here');
  const settings = { ...BASE, combos: normalizeCombos([{ name: 'Trend', conds: ['emaFastOverSlow', 'rsiAbove50'] }]) };
  const trades = await ctx.evaluate(settings);
  assert.ok(trades.length > 0);
  assert.ok(trades.every((t) => days.includes(dayKey(t.entryTime)) && t.priced === 'real'));
  assert.ok(trades.every((t) => dayKey(t.entryTime) === dayKey(t.entryTime)));
  const r = await tune({ days, current: settings, evaluate: ctx.evaluate, dayOf: (t) => dayKey(t.entryTime), usable: ctx.usable });
  assert.ok(['passed', 'failed', 'same'].includes(r.verdict));
  assert.equal(r.split.hiddenDays, 3);
  const p = paramsFor(PARAMS, { ...settings, dailyLossPct: 5 }, 60000);
  assert.equal(p.dailyLoss, 3000);
  assert.equal(p.live, true);
});

test('one combination is tuned on its own on the real replay: its own exits reach the trades, and every result has a verdict', async () => {
  const nifty1 = minutes(16);
  const days = [...new Set(nifty1.map((b) => dayKey(b.time)))].slice(-12);
  const book = bookFor(nifty1, { days });
  const ctx = learnContext({ nifty1, book, params: { ...PARAMS, prices: book }, days, budget: 60000 });
  const [combo] = normalizeCombos([{ name: 'Trend', conds: ['emaFastOverSlow', 'rsiAbove50'] }]);
  const settings = { ...BASE, combos: [combo] };
  const plain = await ctx.evaluate(settings);
  const cut = await ctx.evaluate({ ...settings, combos: [{ ...combo, exits: { cut: 300 } }] });
  assert.ok(plain.length > 0);
  assert.ok(cut.some((t) => t.reason === 'CUT'), 'the own loss cut is used by the replay');
  assert.ok(Math.min(...cut.map((t) => t.gross)) >= -500, 'sold at the cut, or at the next minute open when it jumped past it');
  const r = await tuneCombo({ combo, base: settings, days, evaluate: ctx.evaluate, dayOf: (t) => dayKey(t.entryTime), usable: ctx.usable, deadline: Date.now() + 20000 });
  assert.ok(['passed', 'failed', 'same', 'thin', 'few'].includes(r.verdict), r.verdict);
  assert.ok(r.text.length > 0);
});

test('settings are read from what is saved and written back to the same fields', () => {
  const saved = { combos: [{ id: 'x', name: 'X', conds: ['rsiAbove50'], need: 1, window: 3, on: true }], maxTrades: 2, dailyLossPct: 5, lossStreak: 1, patternStopMode: 'atr', patternStopAtr: 1.5, trailMode: 'points', trailPoints: 30, trailStart: 20, breakEvenPoints: 20, entryFrom: 570, entryTo: 900, patterns: ['breakout'] };
  const defaults = { options: { stopLoss: 2000, steps: [{ at: 800, keep: 500 }], lockOn: true } };
  const s = settingsOf(saved, defaults);
  assert.equal(s.lossLimit, 2000);
  assert.deepEqual(s.steps, [{ at: 800, keep: 500 }]);
  assert.deepEqual(s.stopRule, { mode: 'atr', k: 1.5, points: 30 });
  assert.deepEqual(s.trail, { points: 30, start: 20 });
  assert.equal(s.entryFrom, 570);
  const patch = savePatch({ ...s, steps: [], stopRule: { mode: 'fixed', points: 40 }, trail: null });
  assert.equal(patch.options.patternStopMode, 'fixed');
  assert.equal(patch.options.patternStopPoints, 40);
  assert.equal(patch.options.trailMode, 'off');
  assert.deepEqual(patch.rules, { stopLoss: 2000, steps: [], lockOn: false });
  assert.equal(patch.options.combos[0].id, 'x');
  assert.equal(fingerprint(s), fingerprint(settingsOf(saved, defaults)));
  assert.notEqual(fingerprint(s), fingerprint({ ...s, maxTrades: 4 }));
});

/** Stand-ins for the three models, so apply and undo can be tested without a database. */
function fakeModels(t, { settings, defaults, last }) {
  const writes = [];
  const state = { last, log: [], markModified() {}, async save() { writes.push(['state', this.last]); } };
  const lean = (v) => ({ lean: async () => v });
  t.mock.method(OptionSettings, 'findOne', () => lean(settings));
  t.mock.method(TradeDefaults, 'findOne', () => lean(defaults));
  t.mock.method(LearnerState, 'findOne', (q, ...rest) => {
    const p = Promise.resolve(state);
    p.lean = async () => state;
    return p;
  });
  t.mock.method(OptionSettings, 'findOneAndUpdate', async (_q, update) => {
    writes.push(['options', update.$set]);
    Object.assign(settings, update.$set);
  });
  t.mock.method(TradeDefaults, 'findOneAndUpdate', async (_q, update) => {
    writes.push(['rules', update.$set]);
    defaults.options = { ...defaults.options, stopLoss: update.$set['options.stopLoss'], steps: update.$set['options.steps'], lockOn: update.$set['options.lockOn'] };
  });
  return { writes, state };
}

test('Apply is blocked after a fail unless forced, refused once the settings changed, and Undo puts the old settings back', async (t) => {
  const settings = { combos: [], maxTrades: 3, dailyLossPct: 10 };
  const defaults = { options: { stopLoss: 1500, steps: [{ at: 1000, keep: 750 }], lockOn: true } };
  const current = settingsOf(settings, defaults);
  const last = { verdict: 'failed', changes: [{ label: 'x' }], base: fingerprint(current), current, proposal: { ...current, maxTrades: 1, lossLimit: 1000 } };
  const { writes, state } = fakeModels(t, { settings, defaults, last });
  const learn = new LearnService({ lab: {}, market: { provider: {} } });
  await assert.rejects(learn.apply('u1', {}), /Apply anyway/);
  assert.equal(writes.filter((w) => w[0] === 'options').length, 0);
  const view = await learn.apply('u1', { force: true });
  assert.equal(settings.maxTrades, 1);
  assert.equal(defaults.options.stopLoss, 1000);
  assert.equal(state.last.applied.forced, true);
  assert.equal(view.last.canUndo, true);
  assert.equal(state.log[0].action, 'applied anyway');
  await assert.rejects(learn.apply('u1', { force: true }), /already applied/);
  await learn.undo('u1');
  assert.equal(settings.maxTrades, 3);
  assert.equal(defaults.options.stopLoss, 1500);
  assert.ok(state.last.undone);

  state.last = { ...last, verdict: 'passed', applied: undefined, undone: undefined, base: 'something else' };
  await assert.rejects(learn.apply('u1', {}), /changed after this run/);
  state.last = { verdict: 'same', changes: [] };
  await assert.rejects(learn.apply('u1', {}), /nothing to apply/);
});

// ---------- live ----------

test('live, the chain is read only when a switched-on combination needs it, never on the sample feed, and feeds the chart', async () => {
  assert.equal(combosNeedChain([{ on: true, conds: ['rsiAbove50'] }]), false);
  assert.equal(combosNeedChain([{ on: false, conds: ['pcrAbove1'] }]), false);
  assert.equal(combosNeedChain([{ on: true, conds: ['rsiAbove50'], also: ['ivLow'] }]), true);

  const nifty1 = minutes(3);
  const today = dayKey(nifty1.at(-1).time);
  const book = bookFor(nifty1);
  const expiry = book.expiries(today)[0];
  const rows = book.chain(today, expiry).map((r) => ({ symbol: `NIFTY-${expiry}-${r.strike}-${r.type}`, strike: r.strike, type: r.type, expiry }));
  let calls = 0;
  const provider = {
    isSimulated: false,
    getOptionExpiries: async () => [expiry],
    getOptionContracts: async () => rows,
    getTodayOptionCandles: async (symbol) => {
      calls += 1;
      const r = rows.find((x) => x.symbol === symbol);
      return [...book.contract(today, expiry, r.strike, r.type).values()];
    },
  };
  const now = () => new Date((nifty1.at(-1).time + 60) * 1000);
  const past = new PriceBook(new Map([...book.byDay].filter(([d]) => d !== today)));
  const chain = new LiveChain({ market: { provider }, now, loadPast: async () => past, strikesEachSide: 3 });
  const bars5 = aggregateCandles(nifty1, '5m');
  assert.equal(await chain.seriesFor('NIFTY', bars5, { need: false }), null, 'not needed: nothing is read');
  assert.equal(calls, 0);
  const s = await chain.seriesFor('NIFTY', bars5, { need: true });
  assert.equal(calls, 14, '7 strikes, calls and puts');
  assert.ok(s.pcr.at(-1) > 0 && s.days === 3);
  await chain.seriesFor('NIFTY', bars5, { need: true });
  assert.equal(calls, 14, 'read again only after a few minutes');

  const sample = new LiveChain({ market: { provider: { ...provider, isSimulated: true } }, now, loadPast: async () => past });
  assert.equal(await sample.seriesFor('NIFTY', bars5, { need: true }), null);
});

test('with a deadline it stops trying changes, still judges what it found, and says so; no trades at all is explained', async () => {
  const days = keys(20);
  const r = await tune({ days, current: BASE, evaluate: fakeEvaluate(days, { goodOnHidden: true }), dayOf, usable: () => true, deadline: Date.now() - 1 });
  assert.equal(r.stoppedEarly, true);
  assert.equal(r.changes.length, 0);
  assert.equal(r.verdict, 'same');
  assert.ok(r.windows.length === 3 && r.hidden.old);
  const empty = await tune({ days, current: BASE, evaluate: async () => [], dayOf, usable: () => true });
  assert.equal(empty.verdict, 'same');
  assert.match(empty.text, /made no trade/);
});

test('a run the server never finished shows as interrupted, and a failing run leaves its error to read', async (t) => {
  const settings = { combos: [] };
  const defaults = { options: {} };
  const { state } = fakeModels(t, { settings, defaults, last: null });
  state.log = [{ at: 'x', action: 'started', text: 'Started on 30 days.' }];
  const learn = new LearnService({ lab: { priceBook: async () => { throw new Error('no prices table'); } }, market: { provider: {} } });
  const v = await learn.view('u1');
  assert.match(v.interrupted, /did not finish/);
  const job = learn.start('u1', { days: 30 });
  assert.equal(learn.status('u1').state, 'running');
  await job.done;
  assert.equal(learn.status('u1').state, 'idle');
  assert.equal(state.last.verdict, 'error');
  assert.match(state.last.text, /no prices table/);
  assert.equal(state.log[0].action, 'failed');
  const after = await learn.view('u1');
  assert.equal(after.interrupted, null);
  assert.equal(after.last.verdict, 'error');
});

// ---------- Learn plays by the live gates (20 Nov: Learn +3,114 vs Replay -1,857 on 19 Nov with the same settings) ----------

test('Learn takes the indicator-score entries and skips combinations under the minimum chart score, as live; fills cost the Replay slippage', async () => {
  const nifty1 = minutes(16);
  const days = [...new Set(nifty1.map((b) => dayKey(b.time)))].slice(-12);
  const book = bookFor(nifty1, { days });
  const settings = { ...BASE, combos: normalizeCombos([{ name: 'Trend', conds: ['emaFastOverSlow', 'rsiAbove50'] }]) };
  const plain = await learnContext({ nifty1, book, params: { ...PARAMS, prices: book }, days, budget: 60000 }).evaluate(settings);
  assert.ok(plain.length > 0);
  // a score at every 5-minute close, whatever the settings: a combination needs 101 to be kept, so nothing is
  const scores = new Map();
  const fake = async () => ({ signals: [], scores: new Proxy(scores, { get: (t, k) => (k === 'get' ? () => ({ CE: 10, PE: 10 }) : Reflect.get(t, k)) }) });
  const gated = learnContext({ nifty1, book, params: { ...PARAMS, prices: book, comboMinScore: 60 }, days, budget: 60000, botSignalsFn: fake });
  assert.equal((await gated.evaluate(settings)).length, 0, 'every signal scores 10, under the 60 you asked for');
  const open = learnContext({ nifty1, book, params: { ...PARAMS, prices: book, comboMinScore: 5 }, days, budget: 60000, botSignalsFn: fake });
  assert.equal((await open.evaluate(settings)).length, plain.length, 'a score over the minimum keeps every signal');
  // score entries: a signal of the score bot is traded, and a combination alone does not get it
  const sig = plain[0];
  const scoreBot = async () => ({ signals: [{ technique: 'bot', side: sig.side, i: 20, time: sig.entryTime - 60, close: 23000, stop: sig.side === 'CE' ? 22900 : 23100, atr: 20, score: 90 }], scores: new Map() });
  const withScore = learnContext({ nifty1, book, params: { ...PARAMS, prices: book, scoreEntries: true, scoreMin: 70 }, days, budget: 60000, botSignalsFn: scoreBot });
  const noPatterns = { ...settings, combos: [], patternEntries: false };
  const got = await withScore.evaluate(noPatterns);
  assert.ok(got.every((t) => t.technique === 'score'));
  assert.equal((await withScore.evaluate({ ...noPatterns, scoreEntries: false })).length, got.length, 'the settings object has no say: the saved score switch does');
  // fills: slippage lowers the result
  const slipped = await learnContext({ nifty1, book, params: { ...PARAMS, prices: book, slippage: 0.005 }, days, budget: 60000 }).evaluate(settings);
  assert.ok(slipped.reduce((s, t) => s + t.net, 0) < plain.reduce((s, t) => s + t.net, 0));
});

test('judge: one lucky day carrying the hidden profit fails, but only with enough hidden days', () => {
  const day = (net) => ({ net });
  const mk = (nets) => steady(nets.map((n, i) => ({ entryTime: i, net: n })), nets.map((_, i) => `d${i}`), (t) => `d${t.entryTime}`);
  const old = mk([-100, -100, -100, -100]);
  assert.equal(judge(old, mk([4000, 100, 100, -50])).find((c) => c.key === 'oneDay').ok, false);
  assert.equal(judge(old, mk([1000, 900, 800, -50])).find((c) => c.key === 'oneDay').ok, true);
  assert.equal(judge(mk([0, 0, 0]), mk([4000, 100, 100])).find((c) => c.key === 'oneDay').ok, true, 'three hidden days are too few to say');
  void day;
});

// ---------- bot-calculated stop and targets ----------

test('the bot works out a stop and 3 targets for one combination on the older days and replays the newest days both ways; Apply, switch and Undo', async (t) => {
  const nifty1 = minutes(30);
  const days = [...new Set(nifty1.map((b) => dayKey(b.time)))].slice(-24);
  const book = bookFor(nifty1, { days });
  const settings = { combos: normalizeCombos([{ id: 'trend', name: 'Trend', conds: ['emaFastOverSlow', 'rsiAbove50'] }]), maxTrades: 3, dailyLossPct: 10, patternEntries: false };
  const defaults = { options: { stopLoss: 1500, steps: [{ at: 1000, keep: 750 }], lockOn: true } };
  fakeModels(t, { settings, defaults, last: null });
  t.mock.method(OptionSettings, 'updateOne', async (_q, update) => Object.assign(settings, update.$set));
  const lab = { priceBook: async () => book, optionsData: async () => ({ nifty1, stocks5: null }), optionParams: async () => ({ ...PARAMS }) };
  const learn = new LearnService({ lab, market: { provider: {} }, now: () => new Date('2026-11-20T06:00:00Z') });
  const r = await learn.botSuggest('u1', 'trend');
  assert.equal(r.skipped, undefined, r.skipped);
  assert.equal(r.targets.length, 3);
  assert.ok(r.targets.every((x, i) => i === 0 || x.at > r.targets[i - 1].at), 'targets rise');
  assert.ok(r.stop >= 200 && r.stop <= 1500, `stop ${r.stop}`);
  assert.equal(r.hiddenDays + r.calcDays, days.length);
  assert.ok(r.hiddenFrom > r.calcTo, 'the test days come after the days used for the levels');
  for (const k of ['normal', 'bot']) assert.ok(Number.isFinite(r.test.hidden[k].net) && r.test.hidden[k].trades >= 0);
  assert.ok(['better', 'worse', 'thin'].includes(r.verdict));
  await assert.rejects(learn.botSwitch('u1', 'trend', true), /apply the levels first/);
  let saved = await learn.botApply('u1', 'trend', { stop: r.stop, targets: r.targets }, { verdict: r.verdict });
  assert.equal(saved.bot.on, true);
  assert.equal(saved.bot.prev, null, 'nothing before: Undo removes it');
  assert.equal(saved.bot.setAt, '2026-11-20T06:00:00.000Z');
  saved = await learn.botSwitch('u1', 'trend', false);
  assert.equal(saved.bot.on, false, 'off keeps the levels; the normal ladder works');
  assert.deepEqual(saved.bot.targets, r.targets);
  saved = await learn.botApply('u1', 'trend', { stop: 700, targets: [{ at: 400, part: 50 }, { at: 800, part: 25 }, { at: 1200, part: 25 }] });
  assert.equal(saved.bot.prev.stop, r.stop);
  saved = await learn.botUndo('u1', 'trend');
  assert.equal(saved.bot.stop, r.stop, 'Undo put the first levels back');
  assert.equal(saved.bot.on, false);
  saved = await learn.botUndo('u1', 'trend').catch((e) => e);
  assert.match(saved.message, /Nothing to undo/);
});
