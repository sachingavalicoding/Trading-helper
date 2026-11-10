import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayClock, installClock } from '../src/dayreplay/clock.js';
import { ReplayProvider } from '../src/dayreplay/ReplayProvider.js';
import { replayUriFor } from '../src/dayreplay/seed.js';
import { ReplayManager, SPEEDS } from '../src/dayreplay/manager.js';

const DAY = '2026-11-09';
const open = Date.parse('2026-11-09T03:45:00Z'); // 09:15 IST
const sec = open / 1000;

function fakeClock(startMs = open) {
  let real = 0;
  const clock = new ReplayClock({ startMs, endMs: startMs + 6 * 3600000, speed: 1, realNow: () => real });
  return { clock, advance: (ms) => { real += ms; } };
}

test('the clock runs at the chosen speed, pauses and stops at the end', () => {
  const { clock, advance } = fakeClock();
  advance(1000);
  assert.equal(clock.now(), open + 1000);
  clock.setSpeed(10);
  advance(1000);
  assert.equal(clock.now(), open + 11000);
  clock.pause();
  advance(5000);
  assert.equal(clock.now(), open + 11000);
  clock.resume();
  advance(1000);
  assert.equal(clock.now(), open + 21000);
  clock.setSpeed(50);
  advance(10 * 3600000);
  assert.equal(clock.finished, true);
  assert.equal(clock.now(), open + 6 * 3600000);
});

test('installClock makes new Date() and Date.now() follow the clock, and real Dates keep passing instanceof', () => {
  const { clock, advance } = fakeClock();
  const RealDate = Date;
  const undo = installClock(clock);
  try {
    advance(2000);
    assert.equal(Date.now(), open + 2000);
    assert.equal(new Date().getTime(), open + 2000);
    assert.equal(new Date(5).getTime(), 5);
    assert.ok(new RealDate() instanceof Date);
    assert.ok(new Date() instanceof RealDate);
    assert.equal(Date.UTC(2026, 0, 1), RealDate.UTC(2026, 0, 1));
  } finally {
    undo();
  }
  assert.equal(Date, RealDate);
});

test('the replay database is a separate one and never the live one', () => {
  assert.equal(replayUriFor('mongodb://127.0.0.1:27017/nifty_paper_trader'), 'mongodb://127.0.0.1:27017/nifty_paper_trader_replay');
  assert.equal(replayUriFor('mongodb://u:p@h:27017/app?retryWrites=true'), 'mongodb://u:p@h:27017/app_replay?retryWrites=true');
  assert.equal(replayUriFor('mongodb://h/app_replay'), 'mongodb://h/app_replay');
});

const rows = (symbol, from, prices) => prices.map((ltp, i) => ({ time: from + i, ltp, volume: 100 * (i + 1), totalBuyQty: 0, totalSellQty: 0, bids: [{ price: ltp - 0.05, qty: 10 }], asks: [{ price: ltp + 0.05, qty: 10 }] }));
const OPT = 'NIFTY-20261110-24500-CE';
const source = {
  tickSymbols: async () => ['NIFTY 50', OPT],
  readTicks: async (s) => (s === 'NIFTY 50' ? rows(s, sec, [24500, 24501, 24502, 24499]) : rows(s, sec + 1, [100, 101, 102])),
  readDayCandles: async (s) => (s === 'RELIANCE' ? [{ time: sec, open: 1400, high: 1405, low: 1399, close: 1403, volume: 50 }, { time: sec + 60, open: 1403, high: 1410, low: 1402, close: 1408, volume: 70 }] : []),
  readPrior: async (s) => (s === 'NIFTY 50' ? [{ time: sec - 86400, open: 24400, high: 24600, low: 24300, close: 24450, volume: 1 }] : []),
};

test('prices appear only when the clock reaches their second', async () => {
  const { clock, advance } = fakeClock();
  const p = new ReplayProvider({ source, clock, day: DAY, pollMs: 100000 });
  const ticks = [];
  p.on('tick', (t) => ticks.push(t));
  await p.connect();
  await p.subscribe(['NIFTY 50', OPT, 'RELIANCE']);
  const first = ticks.filter((t) => t.symbol === 'NIFTY 50');
  assert.equal(first.length, 1); // second 0 of Nifty only
  assert.equal(ticks.length, 2); // plus the open of the share's first minute
  assert.equal(first[0].ltp, 24500);
  assert.equal(first[0].prevClose, 24450);
  advance(2000);
  p.subscribe([]); // runs the advance step
  await new Promise((r) => setImmediate(r));
  const nifty = ticks.filter((t) => t.symbol === 'NIFTY 50').map((t) => t.ltp);
  assert.deepEqual(nifty, [24500, 24501, 24502]);
  assert.deepEqual(ticks.filter((t) => t.symbol === OPT).map((t) => t.ltp), [100, 101]);
  assert.equal(ticks.at(-1).source, 'replay');
  await p.disconnect();
});

test('candle history stops at the clock and joins the earlier days', async () => {
  const { clock, advance } = fakeClock();
  const p = new ReplayProvider({ source, clock, day: DAY, pollMs: 100000 });
  await p.connect();
  await p.subscribe(['NIFTY 50', 'RELIANCE']);
  advance(3000);
  await p.subscribe([]);
  const nifty = await p.getHistory('NIFTY 50', '1m');
  assert.equal(nifty.length, 2); // one earlier day + the forming minute
  assert.equal(nifty[1].open, 24500);
  assert.equal(nifty[1].close, 24499);
  assert.equal((await p.getHistory('RELIANCE', '1m')).length, 0); // the first minute has not closed yet
  advance(70000);
  assert.equal((await p.getHistory('RELIANCE', '1m')).length, 1);
  assert.equal((await p.getHistory('RELIANCE', '1m'))[0].close, 1403);
  await p.disconnect();
});

test('without saved candles, only recorded contracts can be picked', async () => {
  const { clock } = fakeClock();
  const p = new ReplayProvider({ source, clock, day: DAY, lotSize: 65 });
  await p.connect();
  assert.deepEqual(await p.getOptionExpiries(), ['2026-11-10']);
  assert.deepEqual(await p.getOptionContracts('2026-11-10'), [{ symbol: OPT, strike: 24500, type: 'CE', expiry: '2026-11-10', lotSize: 65 }]);
  await p.disconnect();
});

test('every strike with saved 1-minute candles can be bought too, priced once a minute', async () => {
  const OPT2 = 'NIFTY-20261110-24550-PE';
  const src = {
    ...source,
    optionCandleSymbols: async () => [OPT, OPT2],
    readDayCandles: async (s) => (s === OPT2 ? [{ time: sec, open: 120, high: 122, low: 119, close: 121, volume: 10 }, { time: sec + 60, open: 121, high: 125, low: 120, close: 124, volume: 12 }] : []),
  };
  const { clock, advance } = fakeClock();
  const p = new ReplayProvider({ source: src, clock, day: DAY, lotSize: 65, pollMs: 100000 });
  await p.connect();
  const listed = await p.getOptionContracts('2026-11-10');
  assert.deepEqual(listed.map((c) => c.symbol).sort(), [OPT, OPT2].sort(), 'recorded and candle-only contracts, once each');
  const ticks = [];
  p.on('tick', (t) => ticks.push(t));
  advance(61000); // the first minute has closed
  await p.subscribe([OPT2]);
  assert.deepEqual(ticks.filter((t) => t.symbol === OPT2).map((t) => t.ltp), [120, 121, 121], 'open and close of the first minute, then the open of the second; never its close');
  await p.disconnect();
});

test('the manager refuses an unknown speed', async () => {
  const m = new ReplayManager({ config: { port: 5000 }, spawnFn: () => assert.fail('no spawn') });
  m.days = async () => [{ day: DAY }];
  await assert.rejects(() => m.start({ day: DAY, speed: 7 }), /Speed must be one of/);
  await assert.rejects(() => m.start({ day: '2026-01-01', speed: 1 }), /no recorded seconds/);
  assert.deepEqual(SPEEDS, [1, 2, 5, 10, 25, 50]);
});

test('a busy job holds the clock, and a late step counts at most maxStepMs', () => {
  let real = 0;
  const clock = new ReplayClock({ startMs: open, endMs: open + 6 * 3600000, speed: 50, realNow: () => real, maxStepMs: 500 });
  real += 100;
  clock.step();
  assert.equal(clock.now(), open + 5000);
  clock.hold();
  real += 3000; // a slow scan
  assert.equal(clock.now(), open + 5000, 'the clock waits for the scan');
  clock.release();
  assert.equal(clock.now(), open + 5000, 'the wait does not count');
  assert.equal(clock.info().busy, false);
  real += 4000; // the phone answered late
  assert.equal(clock.now(), open + 5000 + 500 * 50, 'only maxStepMs of a late step counts');
  clock.step();
  real += 100;
  assert.equal(clock.now(), open + 5000 + 25000 + 5000);
});

test('every() runs on the replay clock, never overlaps, and holds the clock while it runs', async () => {
  const { every } = await import('../src/utils/every.js');
  let virtual = open;
  let holds = 0;
  let maxHolds = 0;
  const clock = { now: () => virtual, hold: () => { holds += 1; maxHolds = Math.max(maxHolds, holds); }, release: () => { holds -= 1; } };
  let runs = 0;
  let finish;
  const job = every(1000, () => { runs += 1; return new Promise((r) => { finish = r; }); }, { clock });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(60);
  assert.equal(runs, 0, 'no virtual second has passed yet');
  virtual += 1000;
  await wait(60);
  assert.equal(runs, 1);
  assert.equal(holds, 1, 'the clock is held while the job runs');
  virtual += 5000;
  await wait(60);
  assert.equal(runs, 1, 'never two runs at once');
  finish();
  await wait(60);
  assert.equal(runs, 2, 'runs again once the last run ended and the time has come');
  finish();
  await wait(10);
  assert.equal(holds, 0, 'every hold was released');
  job.stop();
  assert.equal(maxHolds, 1);
});

test('starting a replay again waits for the old copy to exit before the new one starts', async () => {
  const { EventEmitter } = await import('node:events');
  const order = [];
  const children = [];
  const spawnFn = () => {
    const c = new EventEmitter();
    c.exitCode = null;
    c.signalCode = null;
    c.kill = () => {
      order.push('kill');
      setTimeout(() => {
        order.push('exit');
        c.exitCode = 0;
        c.emit('exit', 0);
      }, 20);
    };
    order.push('spawn');
    children.push(c);
    return c;
  };
  const m = new ReplayManager({ config: { port: 5000 }, spawnFn, fetchFn: async () => ({ ok: false }), readyTimeoutMs: 50 });
  m.days = async () => [{ day: DAY }];
  await m.start({ day: DAY, speed: 1 });
  await m.start({ day: DAY, speed: 5 });
  assert.deepEqual(order, ['spawn', 'kill', 'exit', 'spawn']);
  m.stop();
});

test('only a contract that has a price at the clock can be picked', async () => {
  const LATE = 'NIFTY-20261117-25000-CE';
  const src = {
    ...source,
    optionCandleSymbols: async () => [LATE],
    optionSpans: async () => new Map([[LATE, { first: sec + 600, last: sec + 3000 }]]),
    tickSpans: async () => new Map([[OPT, { first: sec, last: sec + 3 }]]),
  };
  const { clock, advance } = fakeClock();
  const p = new ReplayProvider({ source: src, clock, day: DAY, pollMs: 100000 });
  await p.connect();
  assert.deepEqual(await p.getOptionExpiries(), ['2026-11-10'], 'the later expiry has no price yet');
  advance(601000);
  assert.deepEqual(await p.getOptionExpiries(), ['2026-11-10', '2026-11-17']);
  advance(3000 * 1000);
  assert.deepEqual(await p.getOptionExpiries(), ['2026-11-10'], 'its candles ended');
  await p.disconnect();
});

import { checkItems, whyItems } from '../src/dayreplay/diagnose.js';

const goodFacts = { day: DAY, niftySeconds: 20000, niftyPriorBars: 900, niftyPriorDays: 3, expiries: [{ expiry: '2026-11-10', contracts: 40 }], chosenExpiry: '2026-11-10', optionTickContracts: 10, optionCandleContracts: 30, sharesWithHistory: 50, sharesOnDay: 50, optionSettings: { enabled: true, comboEntries: true, combos: [] , scoreEntries: true }, autoSettings: { enabled: false } };

test('the data check names each missing thing in plain words', () => {
  const ok = checkItems(goodFacts);
  assert.equal(ok.filter((i) => i.level === 'bad').length, 0);
  const bad = checkItems({ ...goodFacts, niftyPriorBars: 0, expiries: [{ expiry: '2026-11-17', contracts: 0 }], chosenExpiry: '2026-11-17', optionSettings: { enabled: false }, sharesOnDay: 3 });
  const text = bad.map((i) => i.text).join('\n');
  assert.match(text, /only 0 saved 1-minute candles/);
  assert.match(text, /No option prices were saved/);
  assert.match(text, /Auto options is OFF/);
  assert.match(text, /only 3 of 50 have 1-minute candles/);
  const later = checkItems({ ...goodFacts, expiries: [{ expiry: '2026-11-10', contracts: 5 }, { expiry: '2026-11-17', contracts: 0 }], chosenExpiry: '2026-11-17' });
  assert.match(later.map((i) => i.text).join('\n'), /expiry on .* but no prices were saved for it/);
});

test('"why no trades" lists the blockers and the bot skip reasons', () => {
  const items = whyItems({
    clockText: '10:42', dateText: '9 Nov', minutes: 642, marketOpen: true, optionSettings: { enabled: true, scoreEntries: true, comboEntries: false }, autoSettings: { enabled: false },
    niftyTick: { ltp: 25000 }, niftyBars: 30, optionRead: 'notReady', expiries: ['2026-11-17'], pick: { symbol: 'NIFTY-20261117-25000-CE', ltp: null },
    sharesWithBars: 0, sharesWithTick: 50, log: [{ segment: 'OPT', decision: 'SKIPPED', reason: 'no live premium for the contract' }, { segment: 'OPT', decision: 'SKIPPED', reason: 'no live premium for the contract' }], loadErrors: [],
  });
  const text = items.map((i) => i.text).join('\n');
  assert.match(text, /Nifty has 30 1-minute candles/);
  assert.match(text, /No price for the strike the bot would buy .*expiry 17 Nov/);
  assert.match(text, /Replay clock 9 Nov 10:42/);
  assert.match(text, /skipped 2×: no live premium/);
});
