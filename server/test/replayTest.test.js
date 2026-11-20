import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { candlePath, ReplayProvider } from '../src/dayreplay/ReplayProvider.js';
import { ReplayClock } from '../src/dayreplay/clock.js';
import { worsePrice } from '../src/services/orderEngine.js';
import { dayResult } from '../src/dayreplay/result.js';
import { beats, clone, fingerprintDocs, hiddenCount, ladderCandidates, ReplayLadder, settingsFileOf, summarize } from '../src/dayreplay/ladder.js';
import { AutoSettings, CandleDay, LearnerState, OptionCandleDay, OptionSettings, ReplayTest, TradeDefaults } from '../src/models/index.js';
import { TickChunk } from '../src/models/TickChunk.js';
import { testUriFor } from '../src/dayreplay/seed.js';

const DAY = '2026-11-09';
const open = Date.parse('2026-11-09T03:45:00Z');
const sec = open / 1000;

test('a 1-minute candle plays open, then low and high (the stop side first), then close', () => {
  const up = candlePath({ time: sec, open: 100, high: 104, low: 98, close: 103, volume: 7 });
  assert.deepEqual(up.map((r) => [r.time - sec, r.ltp]), [[0, 100], [20, 98], [40, 104], [59, 103]]);
  assert.deepEqual(up.map((r) => r.volume), [0, 0, 0, 7], 'the volume comes once, with the close');
  const down = candlePath({ time: sec, open: 100, high: 101, low: 95, close: 96, volume: 1 });
  assert.deepEqual(down.map((r) => r.ltp), [100, 101, 95, 96]);
});

test('by default the replay plays 1-minute candles even for a day with recorded seconds', async () => {
  const NIFTY = 'NIFTY 50';
  const source = {
    tickSymbols: async () => [NIFTY],
    tickSpans: async () => new Map([[NIFTY, { first: sec, last: sec + 100 }]]),
    readTicks: async () => assert.fail('seconds must not be read'),
    readDayCandles: async () => [{ time: sec, open: 100, high: 102, low: 99, close: 101, volume: 0 }],
    readPrior: async () => [],
  };
  let real = 0;
  const clock = new ReplayClock({ startMs: open, endMs: open + 3600000, speed: 1, realNow: () => real });
  const p = new ReplayProvider({ source, clock, day: DAY, pollMs: 100000, useSeconds: false });
  await p.connect();
  const ticks = [];
  p.on('tick', (t) => ticks.push(t.ltp));
  real = 30000;
  await p.subscribe([NIFTY]);
  assert.deepEqual(ticks, [100, 99], 'open and low by second 30');
  assert.equal(p.priceAfter(NIFTY, 15), 102, 'a fill 15 seconds late lands on the high at second 40');
  assert.equal(p.priceAfter('NOPE', 5), null);
  await p.disconnect();
});

test('slippage makes a buy dearer and a sell cheaper, to the tick', () => {
  assert.equal(worsePrice(100, 'BUY', 0.5), 100.5);
  assert.equal(worsePrice(100, 'SELL', 0.5), 99.5);
  assert.equal(worsePrice(100, 'BUY', 0), 100);
  assert.equal(worsePrice(0.05, 'SELL', 50), 0.05, 'never below one tick');
});

test('a day result counts closed round trips after charges, options and shares apart', () => {
  const r = dayResult(DAY, [
    { symbol: 'NIFTY-20261110-24500-CE', segment: 'OPT', status: 'CLOSED', realizedPnl: 1000, charges: 60 },
    { symbol: 'NIFTY-20261110-24500-PE', segment: 'OPT', status: 'CLOSED', realizedPnl: -500, charges: 55 },
    { symbol: 'RELIANCE', segment: 'EQ', status: 'CLOSED', realizedPnl: 50, charges: 80 },
  ]);
  assert.equal(r.trades, 3);
  assert.equal(r.wins, 1);
  assert.equal(r.net, 355);
  assert.deepEqual(r.options, { trades: 2, wins: 1, net: 385, charges: 115 });
  assert.deepEqual(r.shares, { trades: 1, wins: 0, net: -30, charges: 80 });
});

test('summary and the rule a change must pass: more over all the days AND on the newest days', () => {
  const days = [
    { day: 'a', net: 1000, trades: 2, wins: 1 },
    { day: 'b', net: -400, trades: 1, wins: 0 },
    { day: 'c', net: 300, trades: 1, wins: 1 },
  ];
  const s = summarize(days, ['c']);
  assert.equal(s.net, 900);
  assert.equal(s.winRate, 50);
  assert.deepEqual(s.worstDay, { day: 'b', net: -400 });
  assert.equal(s.badDays, 1);
  assert.equal(s.hiddenNet, 300);
  assert.equal(hiddenCount(3), 1);
  assert.equal(hiddenCount(15), 5);
  assert.equal(beats({ net: 1000, hiddenNet: 400 }, s).ok, true);
  assert.match(beats({ net: 1000, hiddenNet: 300 }, s).why, /only fits the older days/);
  assert.equal(beats({ net: 900, hiddenNet: 999 }, s).ok, false);
});

const userId = new mongoose.Types.ObjectId();
const learnState = {
  last: { verdict: 'passed', changes: [{ label: 'Daily loss limit 5%' }, { label: 'Loss cut ₹1500' }], proposal: { combos: [], patternEntries: false, patterns: [], maxTrades: 2, dailyLossPct: 5, lossLimit: 1500, lossStreak: 1, steps: [], stopRule: { mode: 'atr', k: 1 }, trail: null, breakEven: 0, entryFrom: 570, entryTo: 870 } },
  combos: { list: [{ id: 'c1', name: 'Breakout', verdict: 'passed', changes: [{ label: 'Calls only' }], proposal: { side: 'CE' } }, { id: 'c2', name: 'Done', changes: [{ label: 'x' }], proposal: { side: 'PE' }, applied: { at: 'x' } }] },
  shares: { verdict: 'failed', changes: [{ label: 'Last entry 11:30' }], proposal: { entryFrom: 570, entryTo: 690, skip: [], rules: {} } },
};
const liveDocs = () => ({
  optionsettings: { _id: new mongoose.Types.ObjectId(), user: userId, dailyLossPct: 10, maxTrades: 3, combos: [{ id: 'c1', name: 'Breakout', conds: ['emaFastOverSlow', 'ema21Over50'], on: true }] },
  autosettings: { _id: new mongoose.Types.ObjectId(), user: userId, entryFrom: 560, entryTo: 900 },
  tradedefaults: { _id: new mongoose.Types.ObjectId(), user: userId, options: { stopLoss: 2000 } },
});

test('Learn suggestions become changes a test can try; the daily loss limit is never changed', () => {
  const c = ladderCandidates(learnState);
  assert.deepEqual(c.map((x) => x.key), ['setup', 'combo:c1', 'shares'], 'an applied combination is left out');
  assert.deepEqual(c[0].changes, ['Loss cut ₹1500'], 'the daily loss change is not shown as tried');
  const docs = clone(liveDocs());
  c[0].apply(docs);
  assert.equal(docs.optionsettings.dailyLossPct, 10, 'the daily loss limit stays');
  assert.equal(docs.optionsettings.maxTrades, 2);
  assert.equal(docs.tradedefaults.options.stopLoss, 1500);
  const d2 = clone(liveDocs());
  assert.equal(c[1].apply(d2), true);
  assert.equal(d2.optionsettings.combos[0].side, 'CE');
  c[2].apply(d2);
  assert.equal(d2.autosettings.entryTo, 690);
  assert.ok(d2.optionsettings.user instanceof mongoose.Types.ObjectId, 'ids stay ids in the copy');
  const file = mongoose.mongo.BSON.EJSON.parse(settingsFileOf(d2));
  assert.equal(file[OptionSettings.collection.name].length, 1);
  assert.ok(file[OptionSettings.collection.name][0].user instanceof mongoose.Types.ObjectId);
});

test('a test database is separate from the live one and from the hand replay', () => {
  assert.equal(testUriFor('mongodb://h:1/test?x=1'), 'mongodb://h:1/test_test_replay?x=1');
  assert.throws(() => testUriFor('mongodb://h:1/test_replay'), /live database/);
  assert.equal(testUriFor('mongodb+srv://u:p@c.mongodb.net/?retryWrites=true'), 'mongodb+srv://u:p@c.mongodb.net/test_test_replay?retryWrites=true');
});

test('the step-up test keeps a change only when it beats the best so far, and never touches the live settings', async (t) => {
  // stand-ins for the database
  const saved = { doc: null };
  const live = liveDocs();
  const liveBefore = JSON.stringify(live);
  t.mock.method(LearnerState, 'findOne', () => ({ lean: async () => learnState }));
  t.mock.method(OptionSettings, 'findOne', () => ({ lean: async () => live.optionsettings }));
  t.mock.method(AutoSettings, 'findOne', () => ({ lean: async () => live.autosettings }));
  t.mock.method(TradeDefaults, 'findOne', () => ({ lean: async () => live.tradedefaults }));
  t.mock.method(CandleDay, 'distinct', async () => ['2026-11-04', '2026-11-05', '2026-11-06']);
  t.mock.method(OptionCandleDay, 'distinct', async () => ['2026-11-04', '2026-11-05', '2026-11-06']);
  t.mock.method(TickChunk, 'distinct', async () => ['2026-11-06']);
  t.mock.method(ReplayTest, 'findOneAndUpdate', async (_q, u) => ((saved.doc = { _id: 1, ...u.$set }), saved.doc));
  t.mock.method(ReplayTest, 'updateOne', async (_q, u) => {
    for (const [k, v] of Object.entries(u.$set)) {
      const parts = k.split('.');
      let o = saved.doc;
      for (const p of parts.slice(0, -1)) o = o[p];
      o[parts.at(-1)] = v;
    }
  });
  t.mock.method(ReplayTest, 'findOne', () => ({ lean: async () => saved.doc }));
  const runs = [];
  let inFlight = 0;
  let most = 0;
  // options earn by the options settings (now 100, the setup change 200, the combination much more but less on the newest day);
  // shares earn 50 a day only with the shares change. A bot switched off earns nothing.
  const optEarn = { now: [100, 100, 100], setup: [200, 200, 200], combo: [900, 900, 150] };
  const makeRunner = () => ({
    stop() {},
    async runDay({ day, settings, slippagePct, fillDelaySec }) {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      const s = mongoose.mongo.BSON.EJSON.parse(settings);
      const o = s[OptionSettings.collection.name][0];
      const a = s[AutoSettings.collection.name][0];
      const i = ['2026-11-04', '2026-11-05', '2026-11-06'].indexOf(day);
      const kind = o.combos?.[0]?.side === 'CE' ? 'combo' : o.maxTrades === 2 ? 'setup' : 'now';
      runs.push({ day, slippagePct, fillDelaySec, options: o.enabled !== false, shares: a.enabled !== false });
      assert.equal(o.dailyLossPct, 10, 'every run keeps your daily loss limit');
      const options = o.enabled === false ? 0 : optEarn[kind][i];
      const shares = a.enabled === false || a.entryTo !== 690 ? 0 : 50;
      return { day, net: options + shares, trades: 2, wins: 2, options: { trades: 1, wins: 1, net: options, charges: 0 }, shares: { trades: 1, wins: 1, net: shares, charges: 0 } };
    },
  });
  const ladder = new ReplayLadder({ runners: [makeRunner(), makeRunner()] });
  t.mock.method(ReplayTest, 'syncIndexes', async () => {});

  // options on their own: only the options bot plays, only options changes are tried
  await ladder.start(userId, { side: 'options', days: 3, slippagePct: 0.5, fillDelaySec: 2, parallel: 2 });
  assert.equal((await ladder.view(userId, 'shares')).otherRunning, 'options', 'the shares card knows the options test is running');
  await assert.rejects(ladder.start(userId, { side: 'shares', days: 3 }), /options replay test is already running/);
  while (ladder.job) await new Promise((r) => setTimeout(r, 5));
  let d = saved.doc;
  assert.equal(d.state, 'done');
  assert.equal(d.side, 'options');
  assert.deepEqual(d.days, ['2026-11-04', '2026-11-05', '2026-11-06']);
  assert.deepEqual(d.hidden, ['2026-11-06']);
  assert.deepEqual(d.steps.map((s) => s.key), ['now', 'setup', 'combo:c1'], 'no shares change in the options test');
  assert.deepEqual(d.steps.map((s) => s.verdict), ['base', 'kept', 'skipped'], 'the combination is skipped once the whole setup is kept');
  assert.equal(d.steps[1].summary.net, 600);
  assert.equal(runs.length, 6, 'two runs of three days');
  assert.ok(runs.every((r) => r.options && !r.shares), 'the shares bot is off in every options run');
  assert.ok(runs.every((r) => r.slippagePct === 0.5 && r.fillDelaySec === 2));
  assert.equal(most, 2, 'two days play side by side');

  // shares on their own: options are off and the options money does not count
  runs.length = 0;
  await ladder.start(userId, { side: 'shares', days: 3, slippagePct: 0, fillDelaySec: 0, parallel: 1 });
  while (ladder.job) await new Promise((r) => setTimeout(r, 5));
  d = saved.doc;
  assert.equal(d.side, 'shares');
  assert.deepEqual(d.steps.map((s) => s.key), ['now', 'shares']);
  assert.deepEqual(d.steps.map((s) => s.verdict), ['base', 'kept']);
  assert.equal(d.steps[0].summary.net, 0);
  assert.equal(d.steps[1].summary.net, 150);
  assert.ok(runs.every((r) => r.shares && !r.options), 'the options bot is off in every shares run');
  assert.equal(JSON.stringify(live), liveBefore, 'the live settings are untouched');
});

test('Replay test plays only Learn\'s best 5 ideas: passed ones first, then the biggest estimated gain, in the usual order', async () => {
  const { topCandidates, gainOf, MAX_CHECKED } = await import('../src/dayreplay/ladder.js');
  assert.equal(MAX_CHECKED, 5);
  assert.equal(gainOf({ learn: { old: { net: 100 }, new: { net: 600 } }, hidden: { old: { net: 0 }, new: { net: 250 } } }), 750);
  assert.equal(gainOf({}), 0);
  const list = [
    { key: 'setup', verdict: 'failed', gain: 900 },
    { key: 'combo:a', verdict: 'passed', gain: 100 },
    { key: 'combo:b', verdict: 'failed', gain: 800 },
    { key: 'combo:c', verdict: 'thin', gain: 50 },
    { key: 'combo:d', verdict: 'passed', gain: 300 },
    { key: 'combo:e', verdict: 'failed', gain: 700 },
    { key: 'shares', verdict: 'passed', gain: 10 },
  ];
  assert.deepEqual(topCandidates(list).map((c) => c.key), ['setup', 'combo:a', 'combo:b', 'combo:d', 'shares']);
  assert.equal(topCandidates(list.slice(0, 3)).length, 3, 'fewer than 5 are all played');
});

test('each side checks only its own settings: a shares change leaves an options result open to Apply', () => {
  const a = liveDocs();
  const b = clone(a);
  b.autosettings.entryTo = 690;
  b.tradedefaults.shares = { stopLoss: 150 };
  assert.equal(fingerprintDocs(a, 'options'), fingerprintDocs(b, 'options'));
  assert.notEqual(fingerprintDocs(a, 'shares'), fingerprintDocs(b, 'shares'));
  const c = clone(a);
  c.tradedefaults.options.stopLoss = 1000;
  assert.notEqual(fingerprintDocs(a, 'options'), fingerprintDocs(c, 'options'));
  assert.equal(fingerprintDocs(a, 'shares'), fingerprintDocs(c, 'shares'));
});

test('Apply and Undo of one side go through Learn for that side only', async (t) => {
  const calls = [];
  const learn = {
    apply: async () => calls.push('apply setup'),
    applyCombo: async (_u, id) => calls.push(`apply combo ${id}`),
    applyShares: async () => calls.push('apply shares'),
    undo: async () => calls.push('undo setup'),
    undoCombo: async (_u, id) => calls.push(`undo combo ${id}`),
    undoShares: async () => calls.push('undo shares'),
  };
  const live = liveDocs();
  const doc = { _id: 7, side: 'shares', state: 'done', base: fingerprintDocs(live, 'shares'), applied: null, steps: [{ key: 'now', kind: 'now', verdict: 'base' }, { key: 'shares', kind: 'shares', name: 'Shares from Learn', verdict: 'kept' }] };
  t.mock.method(ReplayTest, 'findOne', (q) => ({ lean: async () => (q.side === 'shares' ? doc : null) }));
  t.mock.method(ReplayTest, 'updateOne', async (_q, u) => {
    for (const [k, v] of Object.entries(u.$set)) if (k === 'applied.undone') doc.applied.undone = v; else doc[k] = v;
  });
  t.mock.method(OptionSettings, 'findOne', () => ({ lean: async () => live.optionsettings }));
  t.mock.method(OptionSettings, 'updateOne', async () => {});
  t.mock.method(AutoSettings, 'findOne', () => ({ lean: async () => live.autosettings }));
  t.mock.method(TradeDefaults, 'findOne', () => ({ lean: async () => live.tradedefaults }));
  t.mock.method(LearnerState, 'findOne', () => ({ lean: async () => learnState }));
  t.mock.method(CandleDay, 'distinct', async () => []);
  t.mock.method(OptionCandleDay, 'distinct', async () => []);
  t.mock.method(TickChunk, 'distinct', async () => []);
  const ladder = new ReplayLadder({ runners: [{ stop() {} }], learn });
  await assert.rejects(ladder.apply(userId, 'options'), /Finish the options replay test first/);
  live.optionsettings = { ...live.optionsettings, maxTrades: 9 }; // an options change does not close the shares Apply
  await ladder.apply(userId, 'shares');
  assert.deepEqual(calls, ['apply shares']);
  assert.equal(doc.applied.steps[0].kind, 'shares');
  await assert.rejects(ladder.apply(userId, 'shares'), /Already applied/);
  const v = await ladder.undo(userId, 'shares');
  assert.deepEqual(calls, ['apply shares', 'undo shares']);
  assert.ok(doc.applied.undone);
  assert.equal(v.side, 'shares');
  await assert.rejects(ladder.undo(userId, 'shares'), /Nothing to undo/);
});
