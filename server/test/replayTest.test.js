import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { candlePath, ReplayProvider } from '../src/dayreplay/ReplayProvider.js';
import { ReplayClock } from '../src/dayreplay/clock.js';
import { worsePrice } from '../src/services/orderEngine.js';
import { dayResult } from '../src/dayreplay/result.js';
import { beats, clone, hiddenCount, ladderCandidates, ReplayLadder, settingsFileOf, summarize } from '../src/dayreplay/ladder.js';
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
  await ladder.start(userId, { days: 3, slippagePct: 0.5, fillDelaySec: 2, parallel: 2 });
  while (ladder.job) await new Promise((r) => setTimeout(r, 5));
  const d = saved.doc;
  assert.equal(d.state, 'done');
  assert.deepEqual(d.days, ['2026-11-04', '2026-11-05', '2026-11-06']);
  assert.deepEqual(d.hidden, ['2026-11-06']);
  assert.deepEqual(d.steps.map((s) => s.verdict), ['base', 'kept', 'skipped', 'kept'], 'the combination is skipped once the whole setup is kept');
  assert.equal(d.steps[3].summary.net, 750);
  assert.equal(runs.length, 9, 'three runs of three days');
  assert.ok(runs.every((r) => r.slippagePct === 0.5 && r.fillDelaySec === 2));
  assert.equal(most, 2, 'two days play side by side');
  assert.deepEqual(runs.filter((r) => !r.shares).length, 3, 'the options change replays only the options bot');
  assert.deepEqual(runs.filter((r) => !r.options).length, 3, 'the shares change replays only the shares bot');
  assert.deepEqual(d.steps[3].results.map((r) => r.options.net), [200, 200, 200], 'its options days come from the best run so far');
  assert.equal(JSON.stringify(live), liveBefore, 'the live settings are untouched');
});
