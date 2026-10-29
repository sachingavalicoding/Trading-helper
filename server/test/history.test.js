import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser } from './helpers.js';
import { createApp } from '../src/app.js';
import { HistoryStore, packCandles, unpackCandles } from '../src/market/historyStore.js';
import { HistorySync, windowsBack } from '../src/market/historySync.js';
import { MarketDataService } from '../src/market/MarketDataService.js';
import { MockProvider } from '../src/market/providers/MockProvider.js';
import { CandleDay, CandleCoverage } from '../src/models/index.js';
import { addDays, daysBetween } from '../src/market/days.js';

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => {
  await teardown(ctx);
  await closeDb();
});

// 09:15-15:29 IST on every weekday between two dates, a gentle wave so the numbers have cents
function series(fromDay, toDay) {
  const out = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const t0 = Date.parse(`${day}T03:45:00Z`) / 1000;
    for (let i = 0; i < 375; i++) {
      const base = 24000 + Math.sin(i / 20) * 40 + (daysBetween('2026-01-01', day) % 17) * 3.35;
      out.push({ time: t0 + i * 60, open: base, high: base + 2.25, low: base - 1.8, close: base + 0.55, volume: 1000 + i });
    }
  }
  return out;
}

const at = (iso) => () => new Date(iso);

test('a day of candles packs to a few KB and comes back exactly, and the day helpers count calendar days', () => {
  const day = series('2026-10-26', '2026-10-26');
  assert.equal(day.length, 375);
  const buf = packCandles(day);
  assert.ok(buf.length < 4500, `${buf.length} bytes`);
  assert.deepEqual(unpackCandles(buf, day.length), day.map((c) => ({ ...c, open: Math.round(c.open * 100) / 100, high: Math.round(c.high * 100) / 100, low: Math.round(c.low * 100) / 100, close: Math.round(c.close * 100) / 100 })));
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(daysBetween('2026-10-01', '2026-10-28'), 27);
  assert.deepEqual(windowsBack('2026-09-01', '2026-10-28').map((w) => `${w.from}..${w.to}`), ['2026-10-02..2026-10-28', '2026-09-05..2026-10-01', '2026-09-01..2026-09-04']);
});

test('the store keeps only finished days, reads a range back in order, and trims what is older than the retention', async () => {
  const store = new HistoryStore({ now: at('2026-10-28T08:00:00Z'), retainDays: 20 }); // 13:30 IST: today is not finished
  assert.equal(store.lastCompleteDay(), '2026-10-27');
  const wrote = await store.saveCandles('TCS', series('2026-09-28', '2026-10-28'));
  assert.equal(wrote, 22, 'weekdays from 28 Sep to 27 Oct, not today');
  const got = await store.read('TCS', '2026-10-20', '2026-10-27');
  assert.equal(got.length, 6 * 375);
  assert.ok(got.every((c, i) => i === 0 || c.time > got[i - 1].time));
  assert.equal((await store.read('TCS', '2026-10-28', '2026-10-28')).length, 0);
  await store.setCoverage('TCS', { from: '2026-09-28', to: '2026-10-27' });
  await store.setCoverage('TCS', { from: '2026-10-01', to: '2026-10-10' }); // never shrinks
  assert.deepEqual(await store.coverage('TCS'), { from: '2026-09-28', to: '2026-10-27' });

  const evening = new HistoryStore({ now: at('2026-10-28T10:30:00Z') }); // 16:00 IST
  assert.equal(evening.lastCompleteDay(), '2026-10-28');

  const deleted = await store.prune(); // today 28 Oct, keeps from 8 Oct
  assert.ok(deleted > 0);
  assert.equal(await CandleDay.countDocuments({ symbol: 'TCS', day: { $lt: '2026-10-08' } }), 0);
  assert.equal((await store.coverage('TCS')).from, '2026-10-08');
  const s = await store.summary();
  assert.equal(s.symbols, 1);
  assert.ok(s.bytes > 0 && s.records === (await CandleDay.countDocuments()));
});

function fakeMarket(failOnce = null) {
  const calls = [];
  let failed = false;
  return {
    calls,
    provider: {
      isSimulated: false,
      async getCandlesBetween(symbol, unit, from, to) {
        calls.push(`${symbol} ${from}..${to}`);
        if (failOnce && symbol === failOnce.symbol && calls.filter((c) => c.startsWith(symbol)).length === failOnce.nth && !failed) {
          failed = true;
          throw new Error('HTTP 429 too many requests');
        }
        return series(from, to);
      },
    },
  };
}

test('the download saves a year window by window, keeps going after a refused window and resumes from where it stopped, then only tops up', async () => {
  await CandleDay.deleteMany({});
  const market = fakeMarket({ symbol: 'TCS', nth: 2 });
  const store = new HistoryStore({ now: at('2026-10-28T10:30:00Z') });
  const sync = new HistorySync({ market, store, symbols: ['NIFTY 50', 'TCS'], now: at('2026-10-28T10:30:00Z') });
  const wait = async () => { for (let i = 0; i < 200 && sync.status().state === 'running'; i++) await new Promise((r) => setTimeout(r, 25)); };

  sync.start({ days: 60 });
  await wait();
  assert.equal(sync.status().state, 'partial');
  assert.deepEqual(sync.status().failed.map((f) => f.symbol), ['TCS']);
  const nifty = await store.coverage('NIFTY 50');
  assert.equal(nifty.to, '2026-10-28');
  assert.equal(nifty.from, '2026-08-29');
  const tcsAfterFail = await store.coverage('TCS');
  assert.equal(tcsAfterFail.to, '2026-10-28', 'the first window was kept');
  assert.ok(tcsAfterFail.from > '2026-08-29', 'the second window was not');

  const before = market.calls.length;
  sync.start({ days: 60 });
  await wait();
  assert.equal(sync.status().state, 'done');
  const again = market.calls.slice(before);
  assert.ok(again.every((c) => c.startsWith('TCS')), `only TCS was read again: ${again.join(' | ')}`);
  assert.equal(again.length, 2, 'just the two older windows it had not reached');
  assert.equal((await store.coverage('TCS')).from, '2026-08-29');
  assert.equal(await CandleDay.countDocuments({ symbol: 'NIFTY 50' }), 43, 'weekdays 29 Aug to 28 Oct');

  // the next evening only the new day is read
  const next = new HistorySync({ market, store: new HistoryStore({ now: at('2026-10-29T10:30:00Z') }), symbols: ['NIFTY 50', 'TCS'], now: at('2026-10-29T10:30:00Z') });
  const c0 = market.calls.length;
  assert.equal(await next.behind(), true);
  next.start({ days: 60 });
  for (let i = 0; i < 200 && next.status().state === 'running'; i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(market.calls.slice(c0).sort(), ['NIFTY 50 2026-10-29..2026-10-29', 'TCS 2026-10-29..2026-10-29']);
  assert.equal(await next.behind(), false);
});

test('a study reads the saved days and only asks the broker for what came after them; a symbol with nothing saved goes straight to the broker', async () => {
  await CandleDay.deleteMany({});
  const market = new MarketDataService(new MockProvider(), {});
  const store = new HistoryStore({ now: () => new Date() });
  market.history = store;
  const today = store.today;
  const covTo = addDays(today, -3);
  await store.saveCandles('INFY', series(addDays(today, -40), covTo).filter(() => true));
  await store.setCoverage('INFY', { from: addDays(today, -40), to: covTo });
  const brokerCalls = [];
  market.getRange = async (symbol, unit, days) => {
    brokerCalls.push([symbol, unit, days]);
    return series(addDays(today, -days), today);
  };
  const one = await market.getStudyRange('INFY', 1, 20);
  assert.ok(one.length > 0 && one.every((c, i) => i === 0 || c.time > one[i - 1].time), 'sorted, no duplicates');
  assert.equal(new Set(one.map((c) => c.time)).size, one.length);
  assert.deepEqual(brokerCalls, [['INFY', 1, 4]], 'just the days after the saved ones, today included');
  assert.ok(one.some((c) => c.time >= Date.parse(`${addDays(covTo, 1)}T00:00:00Z`) / 1000 - 19800), 'the newest days come from the broker');
  const five = await market.getStudyRange('INFY', 5, 20);
  assert.ok(five.length < one.length / 4);

  brokerCalls.length = 0;
  await market.getStudyRange('WIPRO', 1, 10);
  assert.deepEqual(brokerCalls, [['WIPRO', 1, 10]], 'nothing saved: as before');

  const minutes = await market.getMinutes('INFY', addDays(today, -20));
  assert.ok(minutes.some((c) => c.time < Date.parse(`${addDays(today, -20)}T00:00:00Z`) / 1000), 'Review gets the days before the one it shows');
});

test('the history routes need a login, report what is saved, and refuse a download on the sample feed', async () => {
  const app = createApp(ctx);
  await request(app).get('/api/history').expect(401);
  const { auth } = await registerUser(app);
  const res = (await request(app).get('/api/history').set(auth).expect(200)).body;
  assert.equal(res.saved.symbols >= 0, true);
  assert.equal(res.job.state, 'idle');
  assert.equal(res.simulated, true);
  assert.match(res.note, /three months/);
  const refused = await request(app).post('/api/history/sync').set(auth).send({}).expect(400);
  assert.match(refused.body.error.message, /Upstox/);
  await request(app).post('/api/history/sync').set(auth).send({ days: 2 }).expect(400);
});

test('a live download saves today so far, reads it again on the next press, and completes it after the close', async () => {
  await CandleDay.deleteMany({});
  await CandleCoverage.deleteMany({});
  let upTo = 200; // candles of today the broker has so far
  const calls = [];
  const market = {
    provider: {
      isSimulated: false,
      async getCandlesBetween(symbol, unit, from, to) {
        calls.push(`${symbol} ${from}..${to}`);
        return series(from, to);
      },
      async getTodayCandles(symbol) {
        calls.push(`${symbol} today`);
        return series('2026-10-29', '2026-10-29').slice(0, upTo);
      },
    },
  };
  const clock = at('2026-10-29T07:30:00Z'); // 13:00 IST, a Thursday
  const store = new HistoryStore({ now: clock });
  const sync = new HistorySync({ market, store, symbols: ['NIFTY 50'], now: clock });
  const wait = async () => { for (let i = 0; i < 200 && sync.status().state === 'running'; i++) await new Promise((r) => setTimeout(r, 25)); };

  sync.start({ days: 10 });
  await wait();
  assert.equal((await store.coverage('NIFTY 50')).to, '2026-10-28', 'without live, today is left out');
  assert.equal(await CandleDay.countDocuments({ symbol: 'NIFTY 50', day: '2026-10-29' }), 0);

  sync.start({ days: 10, live: true });
  await wait();
  assert.deepEqual(await store.coverage('NIFTY 50'), { from: '2026-10-18', to: '2026-10-29', partial: '2026-10-29' });
  const today = await store.read('NIFTY 50', '2026-10-29', '2026-10-29');
  assert.equal(today.length, 200);
  assert.equal(await store.liveAt('NIFTY 50'), today.at(-1).time);
  assert.equal((await store.summary()).liveDay, '2026-10-29');

  upTo = 320;
  calls.length = 0;
  sync.start({ days: 10, live: true });
  await wait();
  assert.deepEqual(calls, ['NIFTY 50 today'], 'only today is read again');
  assert.equal((await store.read('NIFTY 50', '2026-10-29', '2026-10-29')).length, 320, 'the saved day is replaced, not doubled');
  assert.equal(await sync.behind(), false, 'during the session the saved history is not behind');

  // after the close the day is read whole and stops being partial
  const evening = at('2026-10-29T10:30:00Z');
  const store2 = new HistoryStore({ now: evening });
  const sync2 = new HistorySync({ market, store: store2, symbols: ['NIFTY 50'], now: evening });
  assert.equal(await sync2.behind(), true, 'a day saved only up to some time is behind once it is over');
  calls.length = 0;
  sync2.start({ days: 10 });
  for (let i = 0; i < 200 && sync2.status().state === 'running'; i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(calls, ['NIFTY 50 2026-10-29..2026-10-29']);
  assert.deepEqual(await store2.coverage('NIFTY 50'), { from: '2026-10-18', to: '2026-10-29' });
  assert.equal((await store2.read('NIFTY 50', '2026-10-29', '2026-10-29')).length, 375);
  assert.equal(await sync2.behind(), false);
});

test('the sync route takes live and the history report says when today was saved', async () => {
  const app = createApp(ctx);
  const { auth } = await registerUser(app);
  const res = (await request(app).get('/api/history').set(auth).expect(200)).body;
  assert.ok('liveAt' in res);
  assert.match(res.note, /today so far/);
  await request(app).post('/api/history/sync').set(auth).send({ live: 'yes' }).expect(400);
});
