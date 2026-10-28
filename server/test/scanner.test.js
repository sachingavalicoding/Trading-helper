import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { evaluateStock } from '../src/scanner/evaluate.js';
import { sizePosition } from '../src/scanner/sizing.js';
import { ScanIdea } from '../src/models/index.js';
import { setup, teardown, closeDb, registerUser, settle } from './helpers.js';

const DAY = 86400;
const T0 = Date.UTC(2026, 9, 21, 3, 45) / 1000; // 09:15 IST, the previous day
const T1 = T0 + DAY; // 09:15 IST, today

/** 1-minute bars following `close(i)`, each opening where the last one closed. */
function session(start, n, close, vol = () => 1000) {
  const out = [];
  let prev = close(0);
  for (let i = 0; i < n; i++) {
    const c = close(i);
    out.push({ time: start + i * 60, open: prev, high: Math.max(prev, c) + 0.2, low: Math.min(prev, c) - 0.2, close: c, volume: vol(i) });
    prev = c;
  }
  return out;
}

// A quiet earlier session gives the EMAs and the "normal volume for this time of day" something to work with.
const prior = session(T0, 375, (i) => 1000 + (i % 2 ? 1 : -1));

const tickFor = (c1, extra = {}) => ({
  symbol: 'X',
  ltp: c1.at(-1).close,
  open: 1000,
  high: Math.max(...c1.filter((b) => b.time >= T1).map((b) => b.high)),
  low: Math.min(...c1.filter((b) => b.time >= T1).map((b) => b.low)),
  prevClose: 1000,
  changePct: 1,
  totalBuyQty: 7000,
  totalSellQty: 3000,
  ...extra,
});

const run = (c1, { tick = {}, nifty = 0.3, ...opts } = {}) => evaluateStock({ symbol: 'X', tick: tickFor(c1, tick), c1, niftyChangePct: nifty }, opts).candidates;
const find = (list, setup, side) => list.find((c) => c.setup === setup && c.side === side);

/** The same chart upside down around 2000, so a long scenario becomes a short one. */
const mirror = (c1) => c1.map((b) => ({ ...b, open: 2000 - b.open, close: 2000 - b.close, high: 2000 - b.low, low: 2000 - b.high }));

// Opening range 1000-1008, then a breakout that has only just cleared the high.
function orbLong({ amplitude = 3.8, hold = 0.6 } = {}) {
  const or = session(T1, 15, (i) => 1004 + amplitude * Math.sin(i * 0.9), () => 1000);
  const orHigh = Math.max(...or.map((b) => b.high));
  const climb = session(T1 + 15 * 60, 15, (i) => orHigh - 2 + (3 * (i + 1)) / 15, () => 3000);
  const stay = session(T1 + 30 * 60, 3, () => orHigh + hold, () => 3000);
  return { c1: [...prior, ...or, ...climb, ...stay], orHigh };
}

function vwapPullbackLong(bounceBars) {
  const climb = session(T1, 70, (i) => 1000 + i * 0.45);
  let c1 = [...prior, ...climb];
  const vwap = (bars) => {
    let pv = 0;
    let v = 0;
    for (const b of bars.filter((x) => x.time >= T1)) {
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      v += b.volume;
    }
    return pv / v;
  };
  let price = climb.at(-1).close;
  let t = T1 + 70 * 60;
  const down = [];
  for (let k = 0; k < 120; k++) {
    price -= 0.4;
    down.push({ time: t, open: price + 0.4, high: price + 0.6, low: price - 0.2, close: price, volume: 800 });
    t += 60;
    if (price <= vwap([...c1, ...down]) + 0.2) break;
  }
  c1 = [...c1, ...down];
  const bounce = [];
  let p = price;
  for (let k = 0; k < bounceBars; k++) {
    p += 0.7;
    bounce.push({ time: t + k * 60, open: p - 0.7, high: p + 0.2, low: p - 0.9, close: p, volume: 1200 });
  }
  return [...c1, ...bounce];
}

// A swing high near 1010, a break to 1025, a drop back to the old high, and a bounce off it.
function retestLong(bounceBars, { top = 1.5 } = {}) {
  const base = session(T1, 20, (i) => 1000 + (i % 2) * 1.2);
  const up = session(T1 + 20 * 60, 15, (i) => 1002 + (i + 1) * 0.55);
  const down = session(T1 + 35 * 60, 15, (i) => 1010 - (i + 1) * 0.5);
  const drift = session(T1 + 50 * 60, 10, (i) => 1002.5 + (i % 3) * 0.4);
  const brk = session(T1 + 60 * 60, 15, (i) => 1003 + (i + 1) * top);
  const peak = 1003 + 15 * top;
  const pull = session(T1 + 75 * 60, 15, (i) => peak - ((peak - 1010.5) * (i + 1)) / 15);
  const bounce = session(T1 + 90 * 60, 10, (i) => 1010.3 + (i + 1) * 0.3);
  return [...prior, ...base, ...up, ...down, ...drift, ...brk, ...pull, ...bounce.slice(0, bounceBars)];
}

test('opening range breakout: just above the high gives a BUY with a sound plan', () => {
  const { c1, orHigh } = orbLong();
  const c = find(run(c1), 'Opening range breakout', 'BUY');
  assert.ok(c, 'expected an opening range breakout idea');
  assert.equal(c.status, 'ENTRY');
  assert.ok(c.score >= 60);
  assert.ok(c.stopLoss < c.entry && c.entry < c.target1 && c.target1 < c.target2);
  assert.ok(c.riskReward >= 1.5);
  assert.ok(c.entryLow >= Math.floor(orHigh) && c.entryHigh > c.entryLow);
  assert.match(c.stopNote, /opening range/);
  assert.ok(c.reasons.length >= 2 && c.wrongIf);
});

test('opening range breakout mirrors to a SELL below the range low', () => {
  const c = find(run(mirror(orbLong().c1), { tick: { open: 1000 } }), 'Opening range breakout', 'SELL');
  assert.ok(c, 'expected a SELL idea');
  assert.equal(c.status, 'ENTRY');
  assert.ok(c.target2 < c.target1 && c.target1 < c.entry && c.entry < c.stopLoss);
});

test('a tiny opening range is noise and is not traded', () => {
  const list = run(orbLong({ amplitude: 0.4 }).c1);
  assert.equal(find(list, 'Opening range breakout', 'BUY'), undefined);
});

test('chasing is refused: far past the trigger there is no ORB plan', () => {
  const list = run(orbLong({ hold: 6 }).c1);
  assert.equal(list.filter((c) => c.setup === 'Opening range breakout' && c.status === 'ENTRY').length, 0);
});

test('a gap that holds turns the breakout into Gap and go', () => {
  const { c1 } = orbLong();
  const list = run(c1.map((b) => (b.time < T1 ? b : { ...b })), { tick: { prevClose: 990, open: 1000 } });
  assert.ok(find(list, 'Gap and go', 'BUY'));
  assert.equal(find(list, 'Opening range breakout', 'BUY'), undefined);
});

test('VWAP pullback: a bounce off VWAP in an uptrend is an ENTRY, and a late one is MISSED', () => {
  const entry = find(run(vwapPullbackLong(4)), 'VWAP pullback', 'BUY');
  assert.equal(entry.status, 'ENTRY');
  assert.ok(entry.stopLoss < entry.entry && entry.riskReward >= 1.5);
  assert.match(entry.stopNote, /VWAP/);
  const late = find(run(vwapPullbackLong(6)), 'VWAP pullback', 'BUY');
  assert.equal(late.status, 'MISSED');
});

test('level retest: a broken swing high that holds on the way back is an ENTRY', () => {
  const c = find(run(retestLong(7)), 'Level retest', 'BUY');
  assert.equal(c.status, 'ENTRY');
  assert.match(c.reasons[0], /broke above/);
  assert.ok(c.stopLoss < c.entry && c.target1 > c.entry && c.riskReward >= 1.5);
});

test('level retest is refused when the next level is too close to pay', () => {
  const list = run(retestLong(7, { top: 0.75 }));
  assert.equal(find(list, 'Level retest', 'BUY'), undefined);
});

test('a market moving hard against the trade lowers the score', () => {
  const { c1 } = orbLong();
  const calm = find(run(c1, { nifty: 0.3 }), 'Opening range breakout', 'BUY');
  const against = find(run(c1, { nifty: -1.2 }), 'Opening range breakout', 'BUY');
  assert.ok(against.score < calm.score);
  assert.ok(against.penalties.some((p) => /Nifty 50/.test(p)));
});

test('entries are only suggested between 09:30 and 15:15 IST when hours are enforced', () => {
  const { c1 } = orbLong();
  const at = (h, m) => new Date(Date.UTC(2026, 9, 22, h, m) - 330 * 60000);
  assert.ok(run(c1, { enforceWindows: true, now: at(10, 15) }).length > 0);
  assert.equal(run(c1, { enforceWindows: true, now: at(9, 20) }).length, 0);
  assert.ok(run(c1, { enforceWindows: true, now: at(14, 40) }).length > 0);
  assert.ok(run(c1, { enforceWindows: true, now: at(14, 40), legacy: true }).length > 0, 'the old rules allowed entries until 14:45');
  assert.equal(run(c1, { enforceWindows: true, now: at(15, 20) }).length, 0);
  assert.ok(run(c1, { enforceWindows: false, now: at(15, 0) }).length > 0);
});

test('too little history gives no ideas', () => {
  assert.deepEqual(run(prior.slice(0, 20)), []);
});

test('position size risks the chosen percentage and respects free margin', () => {
  const base = { capital: 100000, riskPct: 1, entry: 1500, stopLoss: 1490, available: 100000, leverage: 5, maxQty: 100000 };
  const a = sizePosition(base);
  assert.equal(a.qty, 100); // 1% of 1,00,000 = 1,000 at 10 a share
  assert.equal(a.riskUsed, 1000);
  assert.equal(sizePosition({ ...base, available: 30000 }).qty, 100); // 1,50,000 of buying power still covers 100 x 1500
  const limited = sizePosition({ ...base, available: 10000 });
  assert.equal(limited.qty, 33);
  assert.match(limited.note, /margin/);
  const wide = sizePosition({ ...base, stopLoss: 1000 });
  assert.equal(wide.qty, 2);
  assert.equal(sizePosition({ ...base, stopLoss: 1500 }).qty, 0);
  assert.equal(sizePosition({ ...base, riskPct: 0.1, stopLoss: 1300 }).qty, 0);
});

let ctx;
let clock = new Date();
after(async () => {
  await teardown(ctx);
  await closeDb();
});

const idea = (symbol, ltp, side = 'BUY') => ({
  symbol,
  setup: 'Opening range breakout',
  side,
  status: 'ENTRY',
  entry: ltp,
  stopLoss: side === 'BUY' ? ltp - 5 : ltp + 5,
  target1: side === 'BUY' ? ltp + 10 : ltp - 10,
  target2: side === 'BUY' ? ltp + 20 : ltp - 20,
  riskReward: 2,
  score: 80,
  reasons: ['test'],
  checks: [],
  ltp,
});

test('GET /api/scanner works on the mock feed, sizes positions and needs auth', async () => {
  ctx = await setup({}, { now: () => clock });
  await ctx.scanner.warmUp();
  // The mock feed only ticks on demand in tests, so give every stock one tick to scan.
  for (const symbol of ctx.scanner.symbols) ctx.provider.setPrice(symbol, ctx.provider.getLastTick(symbol).ltp);
  await ctx.scanner.scanOnce();
  const { auth } = await registerUser(ctx.app);
  await request(ctx.app).get('/api/scanner').expect(401);
  await request(ctx.app).get('/api/scanner?risk=50').set(auth).expect(400);
  const res = await request(ctx.app).get('/api/scanner?risk=0.5').set(auth).expect(200);
  assert.equal(res.body.warming, false);
  assert.equal(res.body.loaded, 50);
  assert.equal(res.body.scanned, 50);
  assert.equal(res.body.riskPct, 0.5);
  assert.equal(res.body.capital, 100000);
  assert.ok(Array.isArray(res.body.items) && Array.isArray(res.body.done));
  assert.match(res.body.disclaimer, /Not investment advice/);
  for (const item of res.body.items) {
    assert.ok(['ENTRY', 'WATCHING', 'MISSED'].includes(item.status));
    assert.ok(item.riskReward >= 1.5 && item.score >= 60);
    assert.ok(item.size.riskUsed <= 500);
  }
});

test('an idea is raised once a day, frozen, and closed at target 1', async () => {
  const ltp = ctx.provider.getLastTick('INFY').ltp;
  const closed = [];
  ctx.scanner.on('closed', (i) => closed.push(i));
  const raised = await ctx.scanner.raise(idea('INFY', ltp));
  assert.ok(raised);
  assert.equal(await ctx.scanner.raise(idea('INFY', ltp)), null, 'same stock, setup and side again today');
  assert.equal(await ScanIdea.countDocuments({ symbol: 'INFY' }), 1);

  const { auth } = await registerUser(ctx.app);
  await ctx.scanner.scanOnce();
  const live = (await request(ctx.app).get('/api/scanner').set(auth).expect(200)).body.items.find((i) => i.symbol === 'INFY');
  assert.equal(live.status, 'ENTRY');
  assert.equal(live.target1, ltp + 10, 'plan does not move once raised');
  assert.ok(live.ideaId && live.size.qty >= 0);

  ctx.provider.setPrice('INFY', ltp + 11);
  await settle();
  const doc = await ScanIdea.findOne({ symbol: 'INFY' }).lean();
  assert.equal(doc.status, 'TARGET_HIT');
  assert.equal(closed.length, 1);
  const after = (await request(ctx.app).get('/api/scanner').set(auth).expect(200)).body;
  assert.equal(after.done[0].status, 'TARGET_HIT');
  assert.ok(!after.items.some((i) => i.ideaId === String(doc._id)));
});

test('a short idea stops out when price reaches the stop loss', async () => {
  const ltp = ctx.provider.getLastTick('TCS').ltp;
  await ctx.scanner.raise(idea('TCS', ltp, 'SELL'));
  ctx.provider.setPrice('TCS', ltp + 6);
  await settle();
  assert.equal((await ScanIdea.findOne({ symbol: 'TCS' }).lean()).status, 'STOPPED');
});

test('an idea that does nothing expires after two hours', async () => {
  const ltp = ctx.provider.getLastTick('SBIN').ltp;
  await ctx.scanner.raise(idea('SBIN', ltp));
  clock = new Date(Date.now() + 3 * 3600 * 1000);
  await ctx.scanner.scanOnce();
  const doc = await ScanIdea.findOne({ symbol: 'SBIN' }).lean();
  assert.equal(doc.status, 'EXPIRED');
  clock = new Date();
});

test('hard gates block an idea whatever its score: thin volume, wrong side of the market, no trend', () => {
  const { c1 } = orbLong();
  const good = find(run(c1), 'Opening range breakout', 'BUY');
  assert.deepEqual(good.blocked, [], 'the clean scenario passes every gate');
  assert.ok(good.gates.length >= 6 && good.gates.every((g) => g.pass));

  const againstNifty = find(run(c1, { nifty: -0.9 }), 'Opening range breakout', 'BUY');
  assert.ok(againstNifty.blocked.some((t) => /Nifty 50 is moving against/.test(t)));

  const thin = find(run(c1.map((b) => (b.time >= T1 ? { ...b, volume: 1 } : b))), 'Opening range breakout', 'BUY');
  assert.ok(thin.blocked.some((t) => /Volume is thin/.test(t)));
});

test('a blocked idea is never raised and shows up in the rejected list with its reasons', async () => {
  const { auth } = await registerUser(ctx.app);
  const res = (await request(ctx.app).get('/api/scanner').set(auth).expect(200)).body;
  assert.ok(Array.isArray(res.rejected));
  for (const r of res.rejected) {
    assert.ok(r.reasons.length >= 1 && r.score >= 60);
    assert.ok(!res.items.some((i) => i.symbol === r.symbol && i.status === 'ENTRY' && i.setup === r.setup && i.side === r.side));
  }
  assert.ok(res.calibration && typeof res.calibration === 'object');
});

test('an open idea that price has already run away from cannot be entered', async () => {
  const ltp = ctx.provider.getLastTick('HDFCBANK').ltp;
  await ctx.scanner.raise(idea('HDFCBANK', ltp));
  ctx.provider.setPrice('HDFCBANK', ltp + 4); // 0.8R of a 5-point risk, short of the target
  await settle();
  await ctx.scanner.scanOnce();
  const { auth } = await registerUser(ctx.app);
  const body = (await request(ctx.app).get('/api/scanner').set(auth).expect(200)).body;
  assert.ok(!body.items.some((i) => i.symbol === 'HDFCBANK'), 'it leaves the main list');
  const r = body.rejected.find((x) => x.symbol === 'HDFCBANK');
  assert.equal(r.status, 'LATE');
  assert.match(r.reasons[0], /Too late/);
});

test('a max amount per trade caps the share count', async () => {
  const { sizePosition } = await import('../src/scanner/sizing.js');
  const base = { capital: 1_000_000, riskPct: 1, entry: 1000, stopLoss: 995, available: 1_000_000, leverage: 5, maxQty: 100000 };
  assert.equal(sizePosition(base).qty, 2000);
  const capped = sizePosition({ ...base, maxAmount: 30000 });
  assert.equal(capped.qty, 30);
  assert.equal(capped.amount, 30000);
  assert.match(capped.note, /max of/);
  const { auth } = await registerUser(ctx.app);
  await request(ctx.app).get('/api/scanner?maxAmount=10').set(auth).expect(400);
  await request(ctx.app).get('/api/scanner?maxAmount=30000').set(auth).expect(200);
});

test('a very wide stop loss blocks the idea', () => {
  const { c1 } = orbLong();
  const c = find(run(c1), 'Opening range breakout', 'BUY');
  assert.ok(c.gates.find((g) => g.id === 'stop').pass);
  assert.ok(Math.abs(c.entry - c.stopLoss) / c.entry * 100 <= 1.2);
});

test('three stop-outs in the last four ideas pause new ideas for a while', () => {
  const now = ctx.scanner.now();
  const at = (min) => new Date(now.getTime() - min * 60000);
  ctx.scanner.finished = [{ status: 'TARGET_HIT', at: at(50) }, { status: 'STOPPED', at: at(30) }, { status: 'STOPPED', at: at(20) }, { status: 'STOPPED', at: at(10) }];
  assert.match(ctx.scanner.chopReason(), /Choppy market/);
  ctx.scanner.finished = [{ status: 'STOPPED', at: at(60) }, { status: 'TARGET_HIT', at: at(50) }, { status: 'TARGET_HIT', at: at(40) }, { status: 'STOPPED', at: at(30) }];
  assert.equal(ctx.scanner.chopReason(), null);
  ctx.scanner.finished = [{ status: 'STOPPED', at: at(200) }, { status: 'STOPPED', at: at(190) }, { status: 'STOPPED', at: at(180) }, { status: 'TARGET_HIT', at: at(170) }];
  assert.equal(ctx.scanner.chopReason(), null);
  ctx.scanner.finished = [];
});

test('a setup whose last 20 ideas lost money is switched off, then comes back once they age out', async () => {
  const mk = (n, closedAt) => Array.from({ length: n }, (_, i) => ({ ...idea('TCS', 1000), day: `${closedAt.getTime()}-${i}`, setup: 'Gap and go', status: 'STOPPED', exitPrice: 995, closedAt: new Date(closedAt.getTime() - i * 1000), score: 80 }));
  await ScanIdea.insertMany(mk(19, new Date()));
  ctx.scanner.setupCheckedAt = 0;
  await ctx.scanner.refreshSetupHealth();
  assert.ok(!ctx.scanner.disabledSetups.has('Gap and go'), 'needs a full sample of 20');
  await ScanIdea.insertMany(mk(1, new Date()));
  ctx.scanner.setupCheckedAt = 0;
  await ctx.scanner.refreshSetupHealth();
  assert.match(ctx.scanner.disabledSetups.get('Gap and go'), /switched off/);
  await ScanIdea.deleteMany({ setup: 'Gap and go' });
  await ScanIdea.insertMany(mk(20, new Date(Date.now() - 4 * 24 * 3600 * 1000)));
  ctx.scanner.setupCheckedAt = 0;
  await ctx.scanner.refreshSetupHealth();
  assert.ok(!ctx.scanner.disabledSetups.has('Gap and go'), 'old results no longer count');
  await ScanIdea.deleteMany({ setup: 'Gap and go' });
});

test('market state reads the Nifty 50 trend and the share of stocks that are up', async () => {
  ctx.scanner.marketStateAt = 0;
  const m = await ctx.scanner.refreshMarketState();
  assert.ok(m == null || (m.breadthUp == null || (m.breadthUp >= 0 && m.breadthUp <= 1)));
  if (m?.niftyTrend != null) assert.ok([-1, 0, 1].includes(m.niftyTrend));
});
