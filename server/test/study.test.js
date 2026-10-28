import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser } from './helpers.js';
import { createApp } from '../src/app.js';
import { StudyService } from '../src/study/service.js';
import { prepare, findSignals } from '../src/study/patterns.js';
import { simulateTrade, summarize } from '../src/study/simulate.js';
import { runSharesStudy } from '../src/study/sharesStudy.js';
import { runOptionsStudy, breadthSeries, breadthStudy, patternsWithScore } from '../src/study/optionsStudy.js';

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

test('a bar that closes after 15:15 gives no signal, and no detector looks at a later bar', () => {
  const late = barsFrom(DOUBLE_BOTTOM, Date.UTC(2026, 9, 12, 9, 50) / 1000); // 15:20 IST
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

test('a call that keeps rising is held to 15:15, one that gives back a big gain is sold by the profit lock, one that falls through its stop loses', () => {
  const start = Date.UTC(2026, 9, 12, 4, 30) / 1000; // 10:00 IST
  const rise = minutes(24000, Array.from({ length: 330 }, () => 0.4));
  const held = sim(rise, { side: 'CE', time: start, stop: 23960 });
  assert.equal(held.reason, 'EOD');
  assert.ok(held.gross > 1000 && held.net < held.gross && held.charges > 0, JSON.stringify(held));
  assert.equal(held.exitTime, Date.UTC(2026, 9, 12, 9, 45) / 1000, 'closed at 15:15 IST');

  const gaveBack = minutes(24000, [...Array.from({ length: 100 }, () => 0.8), ...Array.from({ length: 100 }, () => -0.8)]);
  const lock = sim(gaveBack, { side: 'CE', time: start, stop: 23960 });
  assert.equal(lock.reason, 'LOCK');
  assert.ok(lock.best >= 1000 && lock.gross >= lock.best - 400 && lock.gross > 400, `best ${lock.best} gross ${lock.gross}`);

  const falls = minutes(24000, Array.from({ length: 100 }, () => -0.5));
  const stopped = sim(falls, { side: 'CE', time: start, stop: 23980 });
  assert.equal(stopped.reason, 'STOP');
  assert.ok(stopped.net < -500 && stopped.exitSpot <= 23980, JSON.stringify(stopped));
});

test('the replay closes at the exit time you set, and takes no trade at or after it', () => {
  const start = Date.UTC(2026, 9, 12, 4, 30) / 1000; // 10:00 IST
  const rise = minutes(24000, Array.from({ length: 330 }, () => 0.4));
  const at = (exitMin, time = start) => simulateTrade({ c1: rise, byTime: index(rise), signal: { technique: 'x', note: '', side: 'CE', time, stop: 23960 }, params: { ...PARAMS, exitMin } });
  const early = at(14 * 60 + 15);
  assert.equal(early.reason, 'EOD');
  assert.equal(early.exitTime, Date.UTC(2026, 9, 12, 8, 45) / 1000, 'closed at 14:15 IST');
  assert.equal(at(10 * 60 + 30, Date.UTC(2026, 9, 12, 5, 0) / 1000), null, 'a signal at 10:30 is too late for a 10:30 exit');
});

test('a typed lock ladder replaces lockStart and lockGap in the replay: an early first row sells a smaller gain, an empty ladder never locks', () => {
  const start = Date.UTC(2026, 9, 12, 4, 30) / 1000;
  const gaveBack = minutes(24000, [...Array.from({ length: 100 }, () => 0.8), ...Array.from({ length: 100 }, () => -0.8)]);
  const signal = { side: 'CE', time: start, stop: 23960 };
  const run = (steps) => simulateTrade({ c1: gaveBack, byTime: index(gaveBack), signal: { technique: 'x', note: '', ...signal }, params: { ...PARAMS, steps } });
  const plain = sim(gaveBack, signal);
  const same = run([{ at: 1000, keep: 750 }]);
  assert.equal(same.gross, plain.gross, 'one row of 1000 / 750 is the old lockStart 1000 and lockGap 250');
  const early = run([{ at: 300, keep: 250 }, { at: 1000, keep: 800 }]);
  assert.equal(early.reason, 'LOCK');
  assert.ok(early.best >= 1000, `best ${early.best}`);
  assert.ok(early.gross >= 800, `the second row keeps 800: gross ${early.gross}`);
  const none = run([]);
  assert.notEqual(none.reason, 'LOCK', 'no rows, no lock');
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

test('with a loss limit the lots are sized to it like the live trader, a stop too far is skipped, and a fast gap is cut by the hard stop', () => {
  const start = Date.UTC(2026, 9, 12, 4, 30) / 1000;
  const flat = () => minutes(24000, Array.from({ length: 30 }, () => 0));
  const sized = (stop, extra = {}) => simulateTrade({ c1: flat(), byTime: index(flat()), signal: { technique: 'x', side: 'CE', time: start, stop }, params: { ...PARAMS, lossLimit: 1500, maxLots: 2, ...extra } });
  assert.equal(sized(23985).lots, 2, 'a near stop fits two lots');
  assert.equal(sized(23985, { maxLots: 1 }).lots, 1);
  assert.equal(sized(23958).lots, 1, 'a further stop fits one');
  assert.deepEqual(sized(23900), { skipped: 'limit' }, 'even one lot would lose more than the limit');
  assert.equal(sim(flat(), { side: 'CE', time: start, stop: 23900 }).lots, 1, 'without a limit it is one lot');

  const gap = minutes(24000, [0, 0, 0, 0, 0]);
  gap[3] = { ...gap[3], low: 23925, close: 23960 }; // a spike down far enough to cost more than 1.3 times the limit, closing back above the stop
  const t = simulateTrade({ c1: gap, byTime: index(gap), signal: { technique: 'x', side: 'CE', time: start, stop: 23955 }, params: { ...PARAMS, lossLimit: 1500, maxLots: 1 } });
  assert.equal(t.reason, 'HARD');
  assert.ok(t.gross <= -1950 && t.gross > -2600, `gross ${t.gross}`);
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
  const r = await runOptionsStudy({ nifty1, params: { ...PARAMS, days: 10, lossLimit: 1500, maxLots: 2 } });
  assert.equal(r.period.days, 10);
  assert.equal(r.haveBreadth, false);
  const keys = r.techniques.map((t) => t.key);
  for (const k of ['doubleBottom', 'doubleBottomMid', 'botFiltered', 'reversal', 'breakout', 'orb', 'pullback', 'engulfing', 'pinBar', 'insideBar', 'supertrend', 'emaCross', 'confluence', 'agree2', 'agree3', 'bot']) assert.ok(keys.includes(k), k);
  assert.ok(r.techniques.find((t) => t.key === 'agree3').signals <= r.techniques.find((t) => t.key === 'agree2').signals, 'all three agreeing is rarer than any two');
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
  assert.equal(r.params.lossLimit, 1500);
  for (const tr of all) assert.ok(tr.lots >= 1 && tr.lots <= 2, JSON.stringify(tr));
  const bot = r.techniques.find((t) => t.key === 'bot');
  const filtered = r.techniques.find((t) => t.key === 'botFiltered');
  assert.ok(filtered.trades <= bot.trades + 3 && filtered.signals <= bot.signals, 'the filtered bot only drops call entries');
  const keep = ['patternsAll', 'patternScore60', 'patternScore70', 'patternScore80'].map((k) => r.techniques.find((t) => t.key === k));
  assert.ok(keep.every(Boolean), 'the pattern + score tests are in the study');
  for (const k of ['breakoutMid', 'breakoutEngulf']) assert.ok(r.techniques.some((t) => t.key === k), k);
  assert.ok(r.techniques.find((t) => t.key === 'breakoutMid').signals === r.techniques.find((t) => t.key === 'breakout').signals, 'the tighter stop is the same signals');
  assert.ok(keep[1].signals <= keep[0].signals && keep[2].signals <= keep[1].signals && keep[3].signals <= keep[2].signals, 'a higher score floor never adds signals');
  const cut = r.botBreakdown;
  for (const k of ['byTrigger', 'byScore', 'bySide']) assert.ok(Array.isArray(cut[k]), k);
  assert.equal(cut.bySide.reduce((n, x) => n + x.trades, 0), bot.trades, 'every bot trade is in the cut');
});

test('patterns with a score keep only the chosen patterns whose side reached the floor', () => {
  const signals = [
    { technique: 'breakout', side: 'PE', i: 1 },
    { technique: 'breakout', side: 'CE', i: 1 },
    { technique: 'pinBar', side: 'PE', i: 1 },
    { technique: 'pullback', side: 'PE', i: 2 },
    { technique: 'engulfing', side: 'CE', i: 9 },
  ];
  const scores = new Map([[1, { CE: 50, PE: 75 }], [2, { CE: 10, PE: 65 }]]);
  assert.equal(patternsWithScore(signals, scores, null).length, 4, 'no floor: the three patterns, hammer dropped');
  assert.deepEqual(patternsWithScore(signals, scores, 70).map((s) => `${s.technique}${s.side}${s.score}`), ['breakoutPE75']);
  assert.deepEqual(patternsWithScore(signals, scores, 60).map((s) => s.technique), ['breakout', 'pullback']);
  assert.equal(patternsWithScore(signals, scores, 60).some((s) => s.i === 9), false, 'no score read for that bar, so it is dropped');
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

  await request(app).post('/api/study/options').set(u.auth).send({ days: 0 }).expect(400);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 66 }).expect(400);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10, iv: 0.9 }).expect(400);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10, exit: 'target', target: 5 }).expect(400);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10, exit: 'sometimes' }).expect(400);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10, exit: 'target', target: 1500, fixedLots: 1 }).expect(202);
  await request(app).post('/api/study/options').set(u.auth).send({ days: 10 }).expect(409);

  let body;
  for (let i = 0; i < 100; i++) {
    body = (await request(app).get('/api/study/options').set(u.auth).expect(200)).body;
    if (body.status.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(body.status.state, 'idle', JSON.stringify(body.status));
  assert.equal(body.result.period.days, 10);
  assert.deepEqual([body.result.params.exit, body.result.params.target, body.result.params.fixedLots], ['target', 1500, 1]);
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

test('the shares study replays the scanner on each stock and reports by setup, side, hour and how the trades ended, in rupees', async () => {
  const history = { AAA: walk(12, 3), BBB: walk(12, 5), SHORT: walk(1, 9).slice(0, 20) };
  const seen = [];
  const r = await runSharesStudy({ nifty1: walk(12, 7), history, params: { days: 5, riskAmount: 200 }, onProgress: (x) => seen.push(x) });
  assert.equal(r.period.stocks, 2, 'a stock with almost no history is left out');
  assert.equal(r.params.riskAmount, 200);
  assert.equal(seen.length, 2);
  for (const k of ['bySetup', 'bySide', 'byHour', 'byExit', 'firstTarget', 'recent']) assert.ok(Array.isArray(r[k]), k);
  assert.ok(r.overall.trades >= 0 && 'totalNet' in r.overall);
  assert.equal(r.firstTarget.length, 6);
  assert.equal(r.bySetup.reduce((n, x) => n + x.trades, 0), r.overall.trades, 'every trade is in one setup');
  for (const t of r.recent) assert.ok(t.qty >= 1 && Number.isFinite(t.net), JSON.stringify(t));
});

test('the shares study can exit on a fixed rupee target instead of the ladder', async () => {
  const history = { AAA: walk(12, 3), BBB: walk(12, 5) };
  const run = (params) => runSharesStudy({ nifty1: walk(12, 7), history, params: { days: 5, riskAmount: 200, ...params } });
  const lock = await run({ steps: [{ at: 250, keep: 170 }] });
  const target = await run({ target: 300 });
  assert.equal(lock.params.exit, 'lock');
  assert.equal(target.params.exit, 'target');
  assert.equal(target.params.target, 300);
  assert.equal(lock.overall.trades, target.overall.trades, 'the same ideas are traded, only the exits differ');
  assert.ok(!target.byExit.some((x) => x.key === 'Profit lock'), 'with a target there is no lock');
  for (const t of target.recent.filter((x) => x.exit === 'Target')) assert.ok(t.net > 0 && t.net < 400, JSON.stringify(t));
});

test('the shares study runs through the API on the Account stop, is kept per kind, and the days are limited', async () => {
  const nifty = walk(14, 7);
  const stock = walk(14, 3);
  const market = {
    expiryWeekday: 2,
    provider: { isSimulated: false },
    getRange: async (symbol, unit) => (unit === 1 && ['NIFTY 50', 'TCS'].includes(symbol) ? (symbol === 'TCS' ? stock : nifty) : []),
  };
  const study = new StudyService({ market, config: { ...ctx.config, niftyLotSize: 65 } });
  const app = createApp({ ...ctx, study });
  const u = await registerUser(app);
  await request(app).get('/api/study/nope').set(u.auth).expect(404);
  await request(app).post('/api/study/shares').set(u.auth).send({ days: 40 }).expect(400);
  await request(app).post('/api/study/shares').set(u.auth).send({ days: 4 }).expect(202);
  let body;
  for (let i = 0; i < 300; i++) {
    body = (await request(app).get('/api/study/shares').set(u.auth).expect(200)).body;
    if (body.status.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(body.status.state, 'idle', JSON.stringify(body.status));
  assert.equal(body.result.params.riskAmount, 200, 'sized to the Account stop for shares');
  assert.match(body.note, /order book/);
  assert.equal(body.result.params.exit, 'lock');
  assert.deepEqual(body.result.params.steps, [{ at: 250, keep: 170 }], 'your Account ladder rows');
  assert.equal((await request(app).get('/api/study/options').set(u.auth).expect(200)).body.result, null, 'the options study is separate');
});

test('with a target there is no profit lock: the trade is sold when the profit reaches it, a stop in the same bar comes first, and 1 lot can be forced', () => {
  const start = Date.UTC(2026, 9, 12, 4, 30) / 1000;
  const rise = minutes(24000, Array.from({ length: 300 }, () => 0.4));
  const params = { ...PARAMS, target: 1000, lossLimit: 3000, maxLots: 2, fixedLots: 1 };
  const t = simulateTrade({ c1: rise, byTime: index(rise), signal: { technique: 'x', note: '', side: 'CE', time: start, stop: 23900 }, params });
  assert.equal(t.reason, 'TARGET');
  assert.equal(t.lots, 1);
  assert.ok(t.gross >= 999.9 && t.gross < 1100, `gross ${t.gross}`);
  assert.ok(t.exitSpot > t.entrySpot);

  const free = simulateTrade({ c1: rise, byTime: index(rise), signal: { technique: 'x', note: '', side: 'CE', time: start, stop: 23960 }, params: { ...params, fixedLots: 0, lossLimit: 5000, maxLots: 2 } });
  assert.equal(free.lots, 2);
  assert.ok(free.gross >= 1999.9, 'the target counts per lot');

  const lockMode = simulateTrade({ c1: rise, byTime: index(rise), signal: { technique: 'x', note: '', side: 'CE', time: start, stop: 23900 }, params: { ...PARAMS, lossLimit: 3000, maxLots: 1 } });
  assert.notEqual(lockMode.reason, 'TARGET');

  const falls = minutes(24000, Array.from({ length: 100 }, () => -0.5));
  const stopped = simulateTrade({ c1: falls, byTime: index(falls), signal: { technique: 'x', note: '', side: 'CE', time: start, stop: 23980 }, params });
  assert.equal(stopped.reason, 'STOP');
});

// ---------- Review > Patterns ----------

test('review patterns: every signal of a day comes with its stop, the index path after it and a lock exit and a target exit', async () => {
  const { reviewPatterns } = await import('../src/review/patterns.js');
  const c1 = walk(8);
  const day = new Date(c1.at(-1).time * 1000 + 19800_000).toISOString().slice(0, 10);
  let signals = [];
  let seen = null;
  for (const d of [...new Set(c1.map((b) => new Date(b.time * 1000 + 19800_000).toISOString().slice(0, 10)))].slice(3)) {
    const r = reviewPatterns({ c1, day: d, params: { ...PARAMS, lossLimit: 1500, maxLots: 2 } });
    if (r.signals.length > signals.length) {
      signals = r.signals;
      seen = r;
    }
  }
  assert.ok(signals.length >= 2, 'the random chart forms a few patterns on some day');
  assert.ok(seen.candles.length > 60 && seen.candles.every((c) => new Date(c.time * 1000 + 19800_000).toISOString().startsWith(seen.day)));
  assert.ok(!seen.patterns.some((p) => p.key === 'breadth'));
  assert.ok(seen.patterns.some((p) => p.key === 'breakout'));
  const traded = signals.filter((s) => !s.skipped);
  assert.ok(traded.length > 0);
  for (const s of traded) {
    const long = s.side === 'CE';
    assert.ok(long ? s.stop < s.entry : s.stop > s.entry, 'the stop is on the wrong side of the entry for the direction');
    assert.ok(s.best.pts >= 0 && s.worst.pts <= 0);
    assert.ok(s.lock.exitTime > s.time - 1 && s.lock.lots >= 1);
    assert.ok(Math.abs(s.lock.net - (s.lock.gross - s.lock.charges)) < 0.02);
    assert.ok(s.target.reason === 'TARGET' ? s.target.gross >= 1000 * s.target.lots - 0.5 : ['STOP', 'HARD', 'EOD'].includes(s.target.reason));
  }
  for (const s of signals.filter((x) => x.skipped)) assert.ok(['far', 'limit', 'price'].includes(s.skipped));
  const empty = reviewPatterns({ c1, day: '2026-01-01', params: PARAMS });
  assert.deepEqual(empty.signals, []);
  assert.deepEqual(empty.candles, []);
  assert.ok(empty.patterns.length > 5, 'the pattern list is there even on a day without candles');
});

test('review patterns route: needs a login, rejects a bad day and answers for a day the chart has no history for', async () => {
  const app = createApp(ctx);
  await request(app).get('/api/review/patterns').expect(401);
  const { auth } = await registerUser(app);
  await request(app).get('/api/review/patterns?day=bad').set(auth).expect(400);
  const r = (await request(app).get('/api/review/patterns?day=2020-01-01').set(auth).expect(200)).body;
  assert.deepEqual(r.signals, []);
  assert.ok(r.disclaimer);
});
