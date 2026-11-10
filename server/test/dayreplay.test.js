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
  assert.equal(ticks.length, 1); // second 0 of Nifty only
  assert.equal(ticks[0].ltp, 24500);
  assert.equal(ticks[0].prevClose, 24450);
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

test('only recorded contracts can be picked', async () => {
  const { clock } = fakeClock();
  const p = new ReplayProvider({ source, clock, day: DAY, lotSize: 65 });
  await p.connect();
  assert.deepEqual(await p.getOptionExpiries(), ['2026-11-10']);
  assert.deepEqual(await p.getOptionContracts('2026-11-10'), [{ symbol: OPT, strike: 24500, type: 'CE', expiry: '2026-11-10', lotSize: 65 }]);
  await p.disconnect();
});

test('the manager refuses an unknown speed', async () => {
  const m = new ReplayManager({ config: { port: 5000 }, spawnFn: () => assert.fail('no spawn') });
  m.days = async () => [{ day: DAY }];
  await assert.rejects(() => m.start({ day: DAY, speed: 7 }), /Speed must be one of/);
  await assert.rejects(() => m.start({ day: '2026-01-01', speed: 1 }), /no recorded seconds/);
  assert.deepEqual(SPEEDS, [1, 2, 5, 10, 25, 50]);
});
