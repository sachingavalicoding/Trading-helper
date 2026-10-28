import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser } from './helpers.js';
import { createApp } from '../src/app.js';
import { StudyService } from '../src/study/service.js';
import { prepare, findSignals } from '../src/study/patterns.js';
import { simulateTrade, summarize } from '../src/study/simulate.js';
import { runOptionsStudy, breadthSeries, breadthStudy } from '../src/study/optionsStudy.js';

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => {
  await teardown(ctx);
  await closeDb();
});

// Monday 12 Oct 2026, 09:15 IST
const OPEN = Date.UTC(2026, 9, 12, 3, 45) / 1000;

// ---------- patterns ----------

const barsFrom = (closes, start = OPEN) =>
  closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { time: start + i * 300, open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c, volume: 0 };
  });

// two lows near 24003 with a bounce to 24042 between them, then a close above that bounce
const DOUBLE_BOTTOM = [24060, 24054, 24048, 24042, 24036, 24030, 24024, 24018, 24010, 24004, 24012, 24022, 24032, 24040, 24036, 24030, 24022, 24014, 24008, 24005, 24012, 24024, 24038, 24046];
const mirrored = (bars) => bars.map((b) => ({ ...b, open: 48000 - b.open, high: 48000 - b.low, low: 48000 - b.high, close: 48000 - b.close }));

test('a double bottom is a call when the bounce high is broken, a double top is the same pattern for a put, and a flat tape gives no double bottom', () => {
  const calls = findSignals(prepare(barsFrom(DOUBLE_BOTTOM)), { only: ['doubleBottom'] });
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].side, 'CE');
  assert.equal(calls[0].i, DOUBLE_BOTTOM.length - 1);
  assert.ok(calls[0].stop < 24002 && calls[0].stop > 23985, `stop ${calls[0].stop}`);
  assert.equal(calls[0].time, OPEN + DOUBLE_BOTTOM.length * 300, 'the trade is made when the bar has closed');

  const puts = findSignals(prepare(mirrored(barsFrom(DOUBLE_BOTTOM))), { only: ['doubleBottom'] });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].side, 'PE');
  assert.ok(puts[0].stop > 23998 && puts[0].stop < 24015, `stop ${puts[0].stop}`);

  const flat = barsFrom(Array.from({ length: 40 }, (_, i) => 24000 + (i % 2 ? 3 : -3)));
  assert.deepEqual(findSignals(prepare(flat), { only: ['doubleBottom'] }), []);
  assert.deepEqual(findSignals(prepare(barsFrom(DOUBLE_BOTTOM.slice(0, -1)))).filter((s) => s.technique === 'doubleBottom'), [], 'not before the neckline breaks');
});

test('a bar that closes after 14:00 gives no signal, and no detector looks at a later bar', () => {
  const late = barsFrom(DOUBLE_BOTTOM, Date.UTC(2026, 9, 12, 8, 45) / 1000); // 14:15 IST
  assert.deepEqual(findSignals(prepare(late), { only: ['doubleBottom'] }), []);
  const full = findSignals(prepare(barsFrom([...DOUBLE_BOTTOM, 23000, 22000])), { only: ['doubleBottom'] });
  assert.equal(full.length, 1, 'bars after the signal change nothing about it');
});

// ---------- replaying a trade ----------

const minutes = (from, moves, start = Date.UTC(2026, 9, 12, 4, 30) / 1000) => {
  let price = from;
  return moves.map((m, i) => {
    const open = price;
    price += m;
    return { time: start + i * 60, open, high: Math.max(open, price) + 0.5, low: Math.min(open, price) - 0.5, close: price, volume: 0 };
  });
};
const index = (c1) => new Map(c1.map((b, i) => [b.time, i]));
const PARAMS = { iv: 0.14, lockStart: 1000, lockGap: 250, lotSize: 65, holidays: [], expiryWeekday: 2 };
const sim = (c1, signal) => simulateTrade({ c1, byTime: index(c1), signal: { technique: 'x', note: '', ...signal }, params: PARAMS });

test('a call that keeps rising is held to 15:00, one that gives back a big gain is sold by the profit lock, one that falls through its stop loses', () => {
  const start = Date.UTC(2026, 9, 12, 4, 30) / 1000; // 10:00 IST
  const rise = minutes(24000, Array.from({ length: 300 }, () => 0.4));
  const held = sim(rise, { side: 'CE', time: start, stop: 23960 });
  assert.equal(held.reason, 'EOD');
  assert.ok(held.gross > 1000 && held.net < held.gross && held.charges > 0, JSON.stringify(held));
  assert.equal(held.exitTime, Date.UTC(2026, 9, 12, 9, 30) / 1000, 'closed at 15:00 IST');

  const gaveBack = minutes(24000, [...Array.from({ length: 100 }, () => 0.8), ...Array.from({ length: 100 }, () => -0.8)]);
  const lock = sim(gaveBack, { side: 'CE', time: start, stop: 23960 });
  assert.equal(lock.reason, 'LOCK');
  assert.ok(lock.best >= 1000 && lock.gross >= lock.best - 400 && lock.gross > 400, `best ${lock.best} gross ${lock.gross}`);

  const falls = minutes(24000, Array.from({ length: 100 }, () => -0.5));
  const stopped = sim(falls, { side: 'CE', time: start, stop: 23980 });
  assert.equal(stopped.reason, 'STOP');
  assert.ok(stopped.net < -500 && stopped.exitSpot <= 23980, JSON.stringify(stopped));
});

test('a put gains when the index falls, and a stop is only hit by a candle that closes beyond it, not by a wick', () => {
  const start = Date.UTC(2026, 9, 12, 4, 30) / 1000;
  const down = minutes(24000, Array.from({ length: 300 }, () => -0.4));
  const put = sim(down, { side: 'PE', time: start, stop: 24040 });
  assert.ok(put.gross > 1000, JSON.stringify(put));

  const wick = minutes(24000, Array.from({ length: 300 }, () => 0.3));
  wick[3] = { ...wick[3], low: 23950 }; // a spike down through the stop that closes back above it
  const survived = sim(wick, { side: 'CE', time: start, stop: 23980 });
  assert.notEqual(survived.reason, 'STOP');
});

test('the summary counts wins, rupees, drawdown and where the trades ended', () => {
  const t = (net, side = 'CE', reason = 'STOP', at = 0) => ({ net, side, reason, minutes: 30, entryTime: OPEN + at * 3600, exitTime: OPEN + at * 3600 + 1800 });
  const s = summarize([t(500, 'CE', 'LOCK', 0), t(-300, 'PE', 'STOP', 1), t(-200, 'CE', 'STOP', 2), t(1000, 'PE', 'EOD', 3)]);
  assert.equal(s.trades, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.winRate, 50);
  assert.equal(s.net, 1000);
  assert.equal(s.avgWin, 750);
  assert.equal(s.avgLoss, -250);
  assert.equal(s.profitFactor, 3);
  assert.equal(s.best, 1000);
  assert.equal(s.worst, -300);
  assert.equal(s.maxDrawdown, 500);
  assert.deepEqual(s.bySide, { CE: { trades: 2, wins: 1, net: 300 }, PE: { trades: 2, wins: 1, net: 700 } });
  assert.deepEqual(s.byExit, { LOCK: 1, STOP: 2, EOD: 1 });
  assert.equal(summarize([]).trades, 0);
});

// ---------- breadth ----------

test('breadth is the share of the 50 stocks above yesterday\'s close, and falling breadth is followed by what Nifty then did', () => {
  const day2 = Date.UTC(2026, 9, 13, 3, 45) / 1000;
  const stock = (up) => [
    ...Array.from({ length: 20 }, (_, i) => ({ time: OPEN + i * 300, open: 100, high: 101, low: 99, close: 100 })),
    ...Array.from({ length: 20 }, (_, i) => ({ time: day2 + i * 300, open: 100, high: 101, low: 99, close: up ? 101 : 99 })),
  ];
  const stocks = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`S${i}`, stock(i < 10)]));
  const bars5 = barsFrom(Array.from({ length: 20 }, (_, i) => 24100 - i * 10), day2);
  const b = breadthSeries(bars5, stocks);
  assert.equal(b[5], 0.25, 'ten of forty are up');
  assert.equal(breadthSeries(bars5, { S1: stock(true) }), null, 'with too few stocks nothing is guessed');
  const rows = breadthStudy(bars5, b, day2);
  const down = rows.find((r) => r.share === 70 && r.side === 'down');
  assert.equal(down.episodes, 1);
  assert.ok(down.avg30 > 0 && down.hit30 === 100, JSON.stringify(down));
});

// ---------- the whole study ----------

function walk(nDays, seed = 11) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const out = [];
  let price = 24000;
  let t0 = Date.UTC(2026, 9, 5, 3, 45) / 1000;
  for (let d = 0; d < nDays; t0 += 86400) {
    const wd = new Date(t0 * 1000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    let drift = 0;
    for (let m = 0; m < 375; m++) {
      if (m % 60 === 0) drift = (rnd() - 0.5) * 0.9;
      const o = price;
      const c = o + drift + (rnd() - 0.5) * 6;
      out.push({ time: t0 + m * 60, open: o, high: Math.max(o, c) + rnd() * 2, low: Math.min(o, c) - rnd() * 2, close: c, volume: 0 });
      price = c;
    }
    d += 1;
  }
  return out;
}

test('the study trades every technique on the same candles, with one lot, charges taken off, and ranks them by what they made', async () => {
  const nifty1 = walk(14);
  const r = await runOptionsStudy({ nifty1, params: { ...PARAMS, days: 10 } });
  assert.equal(r.period.days, 10);
  assert.equal(r.haveBreadth, false);
  const keys = r.techniques.map((t) => t.key);
  for (const k of ['doubleBottom', 'reversal', 'breakout', 'orb', 'pullback', 'engulfing', 'pinBar', 'insideBar', 'supertrend', 'emaCross', 'confluence', 'bot']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('breadth'), 'no stock history, no breadth technique');
  assert.deepEqual(r.techniques.map((t) => t.net), [...r.techniques.map((t) => t.net)].sort((a, b) => b - a));
  const all = r.techniques.flatMap((t) => t.recent);
  assert.ok(all.length > 20);
  for (const tr of all) {
    assert.ok(Math.abs(tr.net - (tr.gross - tr.charges)) < 0.02, JSON.stringify(tr));
    assert.ok(tr.charges > 0 && tr.minutes >= 1 && ['STOP', 'LOCK', 'EOD'].includes(tr.reason));
    assert.ok(tr.entryTime >= nifty1.find((b) => b.time).time);
  }
  for (const t of r.techniques) assert.ok(t.trades <= t.signals, `${t.key} trades ${t.trades} signals ${t.signals}`);
  const perDay = new Map();
  for (const tr of r.techniques.find((t) => t.key === 'emaCross').recent) perDay.set(new Date((tr.entryTime + 19800) * 1000).toISOString().slice(0, 10), 0);
  assert.equal(r.params.lockStart, 1000);
});

// ---------- the API ----------

test('the study runs in the background, keeps its latest result, refuses a second run at once and checks its input', async () => {
  const nifty1 = walk(30);
  let calls = 0;
  const market = {
    expiryWeekday: 2,
    provider: { isSimulated: false },
    getRange: async (symbol, unit) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return unit === 1 && symbol === 'NIFTY 50' ? nifty1 : [];
    },
  };
  const study = new StudyService({ market, config: { ...ctx.config, niftyLotSize: 65 } });
  const app = createApp({ ...ctx, study });
  const u = await registerUser(app);

  const none = (await request(app).get('/api/study/options').set(u.auth).expect(200)).body;
  assert.equal(none.result, null);
  assert.equal(none.status.state, 'idle');
  assert.match(none.note, /estimated/);

  await request(app).post('/api/study/options').set(u.auth).send({ days: 1 }).expect(400);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10, iv: 0.9 }).expect(400);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10 }).expect(202);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10 }).expect(409);

  let body;
  for (let i = 0; i < 100; i++) {
    body = (await request(app).get('/api/study/options').set(u.auth).expect(200)).body;
    if (body.status.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(body.status.state, 'idle', JSON.stringify(body.status));
  assert.equal(body.result.period.days, 10);
  assert.equal(body.result.simulated, false);
  assert.ok(body.result.techniques.length >= 12);
  assert.ok(calls >= 51, 'Nifty and then the 50 stocks');
  assert.equal(body.result.params.lockGap, 250, 'the lock comes from the Account tab');

  const other = await registerUser(app);
  assert.equal((await request(app).get('/api/study/options').set(other.auth).expect(200)).body.result, null, 'a study belongs to the one who ran it');
  await request(app).get('/api/study/options').expect(401);
});

test('too little Nifty history is reported plainly instead of a made-up result', async () => {
  const study = new StudyService({ market: { expiryWeekday: 2, provider: {}, getRange: async () => [] }, config: { ...ctx.config, niftyLotSize: 65 } });
  const app = createApp({ ...ctx, study });
  const u = await registerUser(app);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10 }).expect(202);
  let body;
  for (let i = 0; i < 50; i++) {
    body = (await request(app).get('/api/study/options').set(u.auth).expect(200)).body;
    if (body.status.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(body.status.state, 'failed');
  assert.match(body.status.error, /Not enough Nifty history/);
  assert.equal(body.result, null);
});
