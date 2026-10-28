import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser, settle } from './helpers.js';
import { createApp } from '../src/app.js';
import { OptionTrader } from '../src/options/optionTrader.js';
import { AutoTrader } from '../src/auto/autoTrader.js';
import { AutoLog, Order, Position, Trade, OptionSettings } from '../src/models/index.js';
import { optionSymbol, parseOptionSymbol, isOptionSymbol, weeklyExpiries, chooseExpiry, atmStrike, optionLabel } from '../src/options/symbols.js';
import { bsPrice, bsDelta, impliedVol } from '../src/options/pricing.js';
import { calculateCharges, roundTripCharges } from '../src/services/charges.js';
import { choppiness, stochastic, heikinAshi, roc, sessionMean } from '../src/signals/indicators.js';
import { readNifty, chartStop, scoreDirection } from '../src/options/signal.js';
import { planTrade } from '../src/options/plan.js';

// ---------- pure pieces ----------

test('an option symbol says its expiry, strike and side, and round-trips', () => {
  const sym = optionSymbol({ expiry: '2026-11-03', strike: 24500, type: 'CE' });
  assert.equal(sym, 'NIFTY-20261103-24500-CE');
  assert.deepEqual(parseOptionSymbol(sym), { expiry: '2026-11-03', strike: 24500, type: 'CE' });
  assert.ok(isOptionSymbol(sym));
  assert.ok(!isOptionSymbol('RELIANCE') && !isOptionSymbol('NIFTY 50') && !isOptionSymbol('BAJAJ-AUTO'));
  assert.equal(optionLabel(sym), 'NIFTY 24500 CE · 3 Nov');
  assert.equal(atmStrike(24523), 24500);
  assert.equal(atmStrike(24526), 24550);
});

test('weekly expiries fall on Tuesdays, move back over a holiday, and expiry day itself rolls to next week', () => {
  const mon = new Date('2026-10-26T05:00:00Z'); // Monday 10:30 IST
  assert.deepEqual(weeklyExpiries(mon, { count: 2 }), ['2026-10-27', '2026-11-03']);
  assert.deepEqual(weeklyExpiries(mon, { count: 2, holidays: ['2026-10-27'] }), ['2026-10-26', '2026-11-03'], 'a Tuesday holiday expires on Monday');
  const expiries = weeklyExpiries(mon, { count: 3 });
  assert.equal(chooseExpiry(expiries, mon), '2026-10-27', 'tomorrow is a full day away');
  const tue = new Date('2026-10-27T05:00:00Z'); // expiry morning
  assert.equal(chooseExpiry(weeklyExpiries(tue, { count: 3 }), tue), '2026-11-03', 'never buy on expiry day');
});

test('Black-Scholes prices a call and a put consistently, and implied volatility recovers the input', () => {
  const base = { spot: 25000, strike: 25000, t: 7 / 365, iv: 0.15 };
  const call = bsPrice({ ...base, type: 'CE' });
  const put = bsPrice({ ...base, type: 'PE' });
  assert.ok(call > 100 && call < 400, `ATM weekly call ${call}`);
  // put-call parity: C - P = S - K e^{-rt}
  assert.ok(Math.abs(call - put - (25000 - 25000 * Math.exp(-0.065 * base.t))) < 0.5);
  assert.ok(bsPrice({ ...base, type: 'CE', spot: 25200 }) > call && bsPrice({ ...base, type: 'PE', spot: 25200 }) < put);
  assert.ok(bsDelta({ ...base, type: 'CE' }) > 0.45 && bsDelta({ ...base, type: 'PE' }) < -0.4);
  assert.ok(Math.abs(impliedVol({ ...base, type: 'CE', premium: call }) - 0.15) < 1e-4);
  assert.equal(impliedVol({ ...base, type: 'CE', premium: 0.01 }), null, 'below the cheapest possible price is not explainable');
});

test('option charges: flat brokerage, tax on the sell premium, and shares are unchanged', () => {
  const buy = calculateCharges({ side: 'BUY', qty: 65, price: 150, segment: 'OPT' });
  const sell = calculateCharges({ side: 'SELL', qty: 65, price: 150, segment: 'OPT' });
  assert.equal(buy.brokerage, 20);
  assert.equal(buy.stt, 0);
  assert.ok(sell.stt > 10 && sell.stamp === 0);
  assert.ok(roundTripCharges({ qty: 65, price: 150, segment: 'OPT' }) > 60);
  assert.deepEqual(calculateCharges({ side: 'BUY', qty: 10, price: 1000 }), calculateCharges({ side: 'BUY', qty: 10, price: 1000, segment: 'EQ' }));
});

// candles: 1-minute bars of an IST session starting 09:15 on a Monday
const START = Date.UTC(2026, 9, 26, 3, 45) / 1000;
const session = (n, close, wick = 2) => Array.from({ length: n }, (_, i) => {
  const c = close(i);
  const o = i === 0 ? c : close(i - 1);
  return { time: START + i * 60, open: o, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, close: c, volume: 0 };
});

test('new indicators: choppiness, stochastic, Heikin-Ashi, rate of change and the session average', () => {
  const trend = session(60, (i) => 24000 + i * 6);
  const range = session(60, (i) => 24000 + (i % 2 ? 4 : -4));
  assert.ok(choppiness(trend) < 40, `trend ${choppiness(trend)}`);
  assert.ok(choppiness(range) > 61.8, `range ${choppiness(range)}`);
  assert.equal(choppiness(trend.slice(0, 5)), null);
  assert.ok(stochastic(trend).k > 85);
  assert.ok(stochastic(session(60, (i) => 24400 - i * 6)).k < 15);
  assert.ok(heikinAshi(trend).streak >= 5);
  assert.ok(heikinAshi(session(60, (i) => 24400 - i * 6)).streak <= -5);
  assert.ok(roc(trend, 6) > 0 && roc(trend.slice(0, 3), 6) === null);
  const mean = sessionMean(trend);
  assert.ok(mean > 24000 && mean < 24360);
});

// ---------- reading the chart ----------

const tickFor = (c1) => ({ symbol: 'NIFTY 50', ltp: c1.at(-1).close });
const steady = (n, slope, start = 24000) => session(n, (i) => start + i * slope + Math.sin(i / 3) * 3);
// a drifting day with pullbacks, long enough for the 15-minute and 50 EMAs to exist
const drift = (n, dir = 1) => session(n, (i) => 24500 + dir * (i * 0.5 + 25 * Math.sin(i / 22) + 7 * Math.sin(i / 3.3)), 3);

test('a steady rise favours a call, a steady fall favours a put, and a sideways tape is blocked', () => {
  const up = drift(330);
  const r = readNifty({ c1: up, tick: tickFor(up), breadthUp: 0.7 });
  assert.ok(r.ready);
  assert.ok(r.ce.score >= 70 && r.ce.score > r.pe.score + 30, `ce ${r.ce.score} pe ${r.pe.score}`);
  assert.equal(r.ce.checks.reduce((s, x) => s + x.max, 0), 100, 'the score is out of 100');

  const down = drift(330, -1);
  const d = readNifty({ c1: down, tick: tickFor(down), breadthUp: 0.3 });
  assert.ok(d.pe.score >= 70 && d.pe.score > d.ce.score + 30, `pe ${d.pe.score} ce ${d.ce.score}`);

  const flat = session(240, (i) => 24000 + (i % 6 < 3 ? 5 : -5) + Math.sin(i) * 2);
  const f = readNifty({ c1: flat, tick: tickFor(flat) });
  assert.ok(f.ce.blocked.some((t) => /sideways/.test(t)) && f.pe.blocked.some((t) => /sideways/.test(t)));
  assert.equal(f.best, null);

  assert.equal(readNifty({ c1: up.slice(0, 20), tick: tickFor(up.slice(0, 20)) }).ready, false, 'too little history: nothing is guessed');
});

// A hand-built clean call setup: trend, breadth and momentum agree, a fresh breakout, a chart stop close by.
function cleanMarket(over = {}) {
  const bar = (t, close, hi = close + 3, lo = close - 3) => ({ time: START + t * 300, open: close - 1, high: hi, low: lo, close });
  const done5 = [...Array.from({ length: 17 }, (_, i) => bar(i, 24960 + (i % 3) * 3)), bar(17, 24980), bar(18, 24990), bar(19, 25000)];
  return {
    spot: 25000, atr5: 25, done5, c5: done5, e9: 24985, e21: 24965, e50: 24900, trend5: 1, trend15: 1, emaStack: 1, mean: 24950,
    st: { dir: 1, line: 24930 }, adx: 28, rsi: 61, macd: { now: 3, prev: 2 }, chop: 40, stoch: { k: 70, d: 62 }, ha: { streak: 4 },
    swings: { lows: [24960], highs: [] }, or: { high: 24970, low: 24900 }, pdh: 24980, pdl: 24850,
    pivots: { pivot: 24900, tc: 24920, bc: 24890, r1: 25110, s1: 24800, widthPct: 0.1 },
    dayHigh: 25003, dayLow: 24890, dayRangePct: 0.45, avgRangePct: 1.1, breadthUp: 0.65,
    lastBar: { open: 24990, high: 25003, low: 24988, close: 25000 }, prevBar: { open: 24980, high: 24992, low: 24978, close: 24990 },
    ...over,
  };
}

test('a clean setup passes every hard check, and each check can say no on its own', () => {
  const ok = scoreDirection(cleanMarket(), 1);
  assert.deepEqual(ok.blocked, []);
  assert.ok(ok.score >= 70, `score ${ok.score}`);
  assert.ok(['Breakout', 'Pullback resume'].includes(ok.trigger.kind), ok.trigger.kind);
  assert.ok(ok.stop.price < 24975 && ok.stop.ok);
  assert.deepEqual(ok.levels.map((l) => l.price), [25100, 25110], 'the round number comes before resistance 1');

  const blockedBy = (over, re) => assert.ok(scoreDirection(cleanMarket(over), 1).blocked.some((t) => re.test(t)), String(re));
  blockedBy({ chop: 70 }, /sideways/);
  blockedBy({ adx: 12 }, /sideways/);
  blockedBy({ trend15: -1 }, /15-minute/);
  blockedBy({ rsi: 82 }, /RSI/);
  blockedBy({ e21: 24900 }, /extended/);
  blockedBy({ avgRangePct: 0.5, dayRangePct: 0.9 }, /already moved/);
  blockedBy({ swings: { lows: [24800], highs: [] }, st: null, e21: 24900, mean: null }, /ATR away/);
  // the same read as a put: nothing agrees
  assert.ok(scoreDirection(cleanMarket(), -1).score < 35);
});

test('entries are only allowed between 09:45 and 14:00 IST when windows are enforced', () => {
  const up = drift(330);
  const at = (h, m) => new Date(Date.UTC(2026, 9, 26, h, m) - 330 * 60000);
  const gateOf = (when) => readNifty({ c1: up, tick: tickFor(up), breadthUp: 0.7 }, { now: when, enforceWindows: true }).ce.gates.find((g) => g.id === 'window').pass;
  assert.equal(gateOf(at(9, 30)), false);
  assert.equal(gateOf(at(11, 0)), true);
  assert.equal(gateOf(at(14, 30)), false);
});

test('the stop sits at a chart level at least 0.8 ATR away, and a level that is too far is refused', () => {
  const up = drift(330);
  const m = readNifty({ c1: up, tick: tickFor(up), breadthUp: 0.7 }).market;
  const s = chartStop(m, 1);
  assert.ok(s.price < m.spot);
  assert.ok(m.spot - s.price >= 0.8 * m.atr5 - 0.1, `stop ${s.price} spot ${m.spot} atr ${m.atr5}`);
  assert.ok(s.note.length > 5);
  const bare = chartStop({ ...m, swings: { lows: [], highs: [] }, st: null, e21: null, mean: null }, 1);
  assert.ok(bare.ok && Math.abs(m.spot - bare.price - m.atr5) < 0.1, 'with no chart level at all it falls back to one ATR');
  const tooFar = chartStop({ ...m, swings: { lows: [m.spot - 3 * m.atr5], highs: [] }, st: null, e21: null, mean: null }, 1);
  assert.equal(tooFar.ok, false);
});

// ---------- planning the trade ----------

const settingsDoc = (over = {}) => ({ budget: 30000, maxLots: 2, ...over });
const rules = { stopLoss: 500, lockStart: 1000, lockGap: 100 };
const mk = (spot = 25000) => ({ spot, atr5: 25, avgRangePct: 1.1, dayRangePct: 0.3 });
const contract = { symbol: optionSymbol({ expiry: '2026-11-03', strike: 25000, type: 'CE' }), strike: 25000, type: 'CE', expiry: '2026-11-03', lotSize: 65 };
const MON = new Date('2026-10-26T05:30:00Z');

test('the stop is the rupees you set, spread over the lots, with no targets and no trailing stop', () => {
  const premium = 210;
  const r = planTrade({ market: mk(), contract, premium, settings: settingsDoc({ maxLots: 1 }), rules, available: 100000, now: MON });
  assert.ok(r.plan, r.skipped);
  const p = r.plan;
  assert.equal(p.lots, 1);
  assert.equal(p.qty, 65);
  assert.ok(Math.abs(p.stopLoss - (premium - 500 / 65)) <= 0.05, `stop ${p.stopLoss}`);
  assert.ok(p.maxLoss > 480 && p.maxLoss <= 505, `loss ${p.maxLoss}`);
  assert.equal(p.target1, undefined);
  assert.equal(p.trailPct, undefined);
  assert.equal(p.lockSteps, undefined);
  assert.equal(p.lockStart, 1000);
  assert.equal(p.lockGap, 100);
  const none = planTrade({ market: mk(), contract, premium, settings: settingsDoc({ maxLots: 1 }), rules: { ...rules, stopLoss: 0 }, available: 100000, now: MON });
  assert.equal(none.plan.stopLoss, null, 'a stop of 0 means no automatic stop');
});

test('more lots are used only while the rupee stop still leaves room in the premium, and money and an expensive premium can refuse the trade', () => {
  const base = { market: mk(), contract, rules, available: 100000, now: MON };
  assert.equal(planTrade({ ...base, premium: 100, settings: settingsDoc() }).plan.lots, 2, '500 over 130 units is 3.8, about 3.8% of a 100 premium');
  assert.equal(planTrade({ ...base, premium: 210, settings: settingsDoc() }).plan.lots, 1, 'on a 210 premium two lots would leave a stop under 2% away, so one lot');
  assert.match(planTrade({ ...base, premium: 900, settings: settingsDoc() }).skipped, /expensive|cost/);
  assert.match(planTrade({ ...base, premium: 210, settings: settingsDoc({ budget: 5000 }), available: 5000 }).skipped, /left to spend/);
  assert.match(planTrade({ ...base, premium: 210, settings: settingsDoc(), available: 3000 }).skipped, /left to spend/);
});

// ---------- the order engine ----------

let ctx;
let app;
let user;
let optionTrader;
let auto;
const api = () => request(app);

before(async () => {
  ctx = await setup();
  optionTrader = new OptionTrader({ market: ctx.market, engine: ctx.engine, config: ctx.config, scanner: ctx.scanner });
  auto = new AutoTrader({ scanner: ctx.scanner, engine: ctx.engine, config: ctx.config });
  app = createApp({ ...ctx, autoTrader: auto, optionTrader });
  user = await registerUser(app);
  ctx.provider.setPrice('NIFTY 50', 25000);
  ctx.provider.setPrice('RELIANCE', 1000);
  await settle();
});
after(async () => {
  await teardown(ctx);
  await closeDb();
});

test('an option is bought for its whole premium, in whole lots, and never written', async () => {
  const c = await ctx.market.pickOption({ type: 'CE', now: new Date() });
  assert.ok(c.ltp > 20, `premium ${c.ltp}`);
  assert.equal(c.lotSize, 65);
  const lot = c.lotSize;
  await api().post('/api/orders').set(user.auth).send({ symbol: c.symbol, side: 'BUY', qty: lot + 1 }).expect(400);
  const sell = (await api().post('/api/orders').set(user.auth).send({ symbol: c.symbol, side: 'SELL', qty: lot }).expect(200)).body.order;
  assert.equal(sell.status, 'REJECTED');
  assert.match(sell.rejectReason, /Writing/);

  const before = (await api().get('/api/wallet').set(user.auth)).body;
  const placed = (await api().post('/api/orders').set(user.auth).send({ symbol: c.symbol, side: 'BUY', qty: lot }).expect(201)).body;
  assert.equal(placed.order.status, 'FILLED');
  assert.equal(placed.order.segment, 'OPT');
  assert.equal(placed.trades[0].charges.brokerage, 20, 'option brokerage is a flat fee');
  const after = (await api().get('/api/wallet').set(user.auth)).body;
  const cost = placed.order.avgFillPrice * lot;
  assert.ok(Math.abs(after.usedMargin - before.usedMargin - cost) < 1, `margin ${after.usedMargin} vs cost ${cost}`);
  const pos = await Position.findOne({ user: user.user.id || user.user._id, symbol: c.symbol, status: 'OPEN' });
  assert.equal(pos.segment, 'OPT');
  assert.equal((await Trade.findOne({ order: placed.order._id })).segment, 'OPT');

  // sell it back (closing a long is allowed)
  await api().post(`/api/positions/${c.symbol}/exit`).set(user.auth).expect(200);
  assert.equal((await Position.findById(pos._id)).status, 'CLOSED');
});

test('shares and options are listed apart: positions, orders, trades and the dashboard', async () => {
  const fresh = await registerUser(app);
  const c = await ctx.market.pickOption({ type: 'PE', now: new Date() });
  await api().post('/api/orders').set(fresh.auth).send({ symbol: 'RELIANCE', side: 'BUY', qty: 5 }).expect(201);
  await api().post('/api/orders').set(fresh.auth).send({ symbol: c.symbol, side: 'BUY', qty: c.lotSize }).expect(201);
  const names = async (path) => (await api().get(path).set(fresh.auth).expect(200)).body;
  assert.deepEqual((await names('/api/positions?status=OPEN')).positions.map((p) => p.symbol), ['RELIANCE'], 'shares by default');
  const opt = (await names('/api/positions?status=OPEN&segment=OPT')).positions;
  assert.deepEqual(opt.map((p) => p.symbol), [c.symbol]);
  assert.equal(opt[0].option.type, 'PE');
  assert.match(opt[0].label, /PE/);
  assert.equal((await names('/api/positions?status=OPEN&segment=ALL')).positions.length, 2);
  assert.ok((await names('/api/orders')).orders.every((o) => o.symbol === 'RELIANCE'));
  assert.ok((await names('/api/orders?segment=OPT')).orders.every((o) => o.symbol === c.symbol));
  assert.ok((await names('/api/trades')).trades.every((t) => t.symbol === 'RELIANCE'));
  assert.ok((await names('/api/trades?segment=OPT')).trades.every((t) => t.symbol === c.symbol));
  const optDash = await names('/api/dashboard?segment=OPT');
  assert.equal(optDash.openPositions.length, 1);
  assert.equal((await names('/api/dashboard')).openPositions.length, 1);
  await api().post('/api/positions/exit-all').set(fresh.auth).expect(200);
});

test('moving the Nifty moves its option: a call gains when the index rises, a put loses', async () => {
  ctx.provider.setPrice('NIFTY 50', 25000);
  const ce = await ctx.market.pickOption({ type: 'CE', now: new Date() });
  const pe = await ctx.market.pickOption({ type: 'PE', now: new Date() });
  const ce0 = ctx.market.getLtp(ce.symbol);
  const pe0 = ctx.market.getLtp(pe.symbol);
  ctx.provider.setPrice('NIFTY 50', 25100);
  assert.ok(ctx.market.getLtp(ce.symbol) > ce0 + 20, 'a 100 point rise lifts a call by much of that');
  assert.ok(ctx.market.getLtp(pe.symbol) < pe0 - 20);
  ctx.provider.setPrice('NIFTY 50', 25000);
});

test('a trailing stop on an option may be much wider than on a share', async () => {
  const fresh = await registerUser(app);
  const c = await ctx.market.pickOption({ type: 'CE', now: new Date() });
  await api().post('/api/orders').set(fresh.auth).send({ symbol: c.symbol, side: 'BUY', qty: c.lotSize }).expect(201);
  await api().put(`/api/positions/${c.symbol}/exits`).set(fresh.auth).send({ trailPct: 30 }).expect(200);
  await api().put(`/api/positions/${c.symbol}/exits`).set(fresh.auth).send({ trailPct: 80 }).expect(400);
  await api().post('/api/orders').set(fresh.auth).send({ symbol: 'RELIANCE', side: 'BUY', qty: 5 }).expect(201);
  await api().put('/api/positions/RELIANCE/exits').set(fresh.auth).send({ trailPct: 30 }).expect(400);
  await api().post('/api/positions/exit-all').set(fresh.auth).expect(200);
});

// ---------- the trader ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A call setup built on the real chart reading, with the pieces the decision depends on set by hand.
function callRead(spotNow, stopGap = 40) {
  const up = drift(330);
  const read = readNifty({ c1: up, tick: { symbol: 'NIFTY 50', ltp: spotNow }, breadthUp: 0.7 });
  const side = { ...read.ce, blocked: [], score: 84, trigger: { kind: 'Breakout', level: spotNow - 5, note: 'closed above the last hour\'s high' }, stop: { price: spotNow - stopGap, note: 'below the last swing low', ok: true }, levels: [{ kind: 'prev day high', price: spotNow + 110 }] };
  return { ...read, ready: true, best: side, lead: side };
}

test('the trader buys a call with the Account stop and profit lock, no target and no trailing stop, and logs it as an option trade', async () => {
  const fresh = await registerUser(app);
  const uid = fresh.user.id || fresh.user._id;
  ctx.provider.setPrice('NIFTY 50', 25000);
  const s = (await OptionSettings.create({ user: uid, enabled: true })).toObject();
  const read = callRead(25000);
  const r = await optionTrader.consider(s, read);
  assert.ok(r.order, r.skipped);
  assert.equal(r.order.source, 'AUTO');
  const sym = r.plan.symbol;
  assert.ok(r.plan.qty % 65 === 0 && r.plan.lots <= 2);

  const pos = await Position.findOne({ user: uid, symbol: sym, status: 'OPEN' });
  assert.equal(pos.segment, 'OPT');
  assert.equal(pos.stepPrices.length, 0);
  assert.equal(pos.lockSteps.length, 0);
  assert.equal(pos.trailPct, null);
  assert.equal(pos.lockTrigger, 1000, 'the lock starts at +1,000');
  assert.equal(pos.lockAmount, 900, 'and keeps 100 less than the profit');
  const sl = await Order.findOne({ user: uid, symbol: sym, role: 'STOPLOSS', status: 'OPEN' });
  assert.equal(sl.triggerPrice, r.plan.stopLoss);
  const loss = (pos.avgPrice - sl.triggerPrice) * pos.netQty;
  assert.ok(loss > 480 && loss <= 505, `the stop loses about 500, not ${loss}`);
  assert.equal(await Order.countDocuments({ user: uid, symbol: sym, role: 'TARGET', status: 'OPEN' }), 0);

  const log = await AutoLog.findOne({ user: uid, segment: 'OPT', decision: 'PLACED' }).lean();
  assert.equal(log.symbol, sym);
  assert.equal(log.status, 'OPEN');
  assert.equal(log.detail.type, 'CE');
  assert.ok(log.card.checks.length > 10);

  const today = await optionTrader.todaySummary(uid);
  assert.equal(today.trades, 1);
  assert.equal(today.open, 1);
  assert.equal((await auto.todaySummary(uid)).trades, 0, 'option trades do not count against the share auto-trader');

  // a second call is refused: one at a time
  const again = await optionTrader.consider(s, callRead(25000));
  assert.match(again.skipped, /already/);
  await api().post('/api/positions/exit-all').set(fresh.auth).expect(200);
});

test('the fixed rupee stop closes a losing trade, the log says STOP, and it cools off afterwards', async () => {
  const fresh = await registerUser(app);
  const uid = fresh.user.id || fresh.user._id;
  ctx.provider.setPrice('NIFTY 50', 25000);
  await settle();
  const s = (await OptionSettings.create({ user: uid, enabled: true })).toObject();
  optionTrader.start();
  try {
    const r = await optionTrader.consider(s, callRead(25000));
    assert.ok(r.order, r.skipped);
    for (let spot = 24992; spot >= 24940; spot -= 4) { // the index slides and the premium falls through the stop
      ctx.provider.setPrice('NIFTY 50', spot);
      await settle();
    }
    await sleep(200);
    assert.equal((await Position.findOne({ user: uid, symbol: r.plan.symbol })).status, 'CLOSED');
    const row = await AutoLog.findOne({ user: uid, segment: 'OPT', decision: 'PLACED' }).lean();
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.outcome.exitReason, 'STOP');
    assert.ok(row.outcome.netPnl < 0 && row.outcome.resultR < 0);
    assert.ok(row.outcome.grossPnl >= -560, `the stop kept the loss near 500, got ${row.outcome.grossPnl}`);
    const next = await optionTrader.consider(s, callRead(25000));
    assert.match(next.skipped, /cooling off/);
  } finally {
    optionTrader.stop();
    ctx.provider.setPrice('NIFTY 50', 25000);
  }
});

test('the profit lock takes the profit once it has been past the start: +1,000 keeps 900 and it follows 100 behind', async () => {
  const fresh = await registerUser(app);
  const uid = fresh.user.id || fresh.user._id;
  ctx.provider.setPrice('NIFTY 50', 25000);
  await settle();
  const s = (await OptionSettings.create({ user: uid, enabled: true, maxLots: 1 })).toObject();
  const r = await optionTrader.consider(s, callRead(25000));
  assert.ok(r.order, r.skipped);
  const stopAt = async () => (await Order.findOne({ user: uid, symbol: r.plan.symbol, role: 'STOPLOSS', status: 'OPEN' }).lean()).triggerPrice;
  const first = await stopAt();
  let high = first;
  for (let spot = 25004; spot <= 25100; spot += 4) {
    ctx.provider.setPrice('NIFTY 50', spot);
    await settle();
    await sleep(15);
    const pos = await Position.findOne({ user: uid, symbol: r.plan.symbol }).lean();
    if (pos.status !== 'OPEN') break;
    const stop = await stopAt();
    assert.ok(stop >= high - 0.001, 'the stop never moves down');
    high = stop;
    const profit = (this_ltp(pos) - pos.avgPrice) * pos.netQty;
    if (profit >= 1000) assert.ok((stop - pos.avgPrice) * pos.netQty >= profit - 100 - 65 * 0.3, `stop keeps about profit minus 100: profit ${profit}`);
  }
  assert.ok(high > r.plan.premium, 'the stop rose above the entry');
  await api().post('/api/positions/exit-all').set(fresh.auth).expect(200);
});
function this_ltp(pos) {
  return ctx.market.getLtp(pos.symbol);
}

test('everything the auto trader bought is closed by 15:00 and nothing is closed for going nowhere', async () => {
  const fresh = await registerUser(app);
  const uid = fresh.user.id || fresh.user._id;
  ctx.provider.setPrice('NIFTY 50', 25000);
  await settle();
  const s = (await OptionSettings.create({ user: uid, enabled: true })).toObject();
  const r = await optionTrader.consider(s, callRead(25000));
  assert.ok(r.order, r.skipped);

  const later = new OptionTrader({ market: ctx.market, engine: ctx.engine, config: ctx.config, now: () => new Date(Date.now() + 40 * 60000) });
  await later.init();
  later.start();
  try {
    await later.manage(uid);
    await sleep(100);
    assert.equal((await Position.findOne({ user: uid, symbol: r.plan.symbol })).status, 'OPEN', 'forty minutes of going nowhere is not a reason to close');
  } finally {
    later.stop();
  }

  // 15:05 IST, whatever the trade is doing
  const late = new OptionTrader({ market: ctx.market, engine: ctx.engine, config: ctx.config, now: () => new Date(Date.UTC(2026, 9, 26, 9, 35)) });
  await late.init();
  late.start();
  try {
    await late.manage(uid);
    await sleep(100);
    assert.equal((await Position.findOne({ user: uid, symbol: r.plan.symbol })).status, 'CLOSED');
    const row = await AutoLog.findOne({ user: uid, segment: 'OPT', decision: 'PLACED' }).lean();
    assert.equal(row.outcome.exitReason, 'TIME');
  } finally {
    late.stop();
  }
});

test('blocked and weak setups are logged once with the reason, not on every scan', async () => {
  const fresh = await registerUser(app);
  const uid = fresh.user.id || fresh.user._id;
  const s = (await OptionSettings.create({ user: uid, enabled: true })).toObject();
  const read = callRead(25000);
  const blocked = { ...read, best: null, lead: { ...read.best, blocked: ['The index is moving sideways, where options lose to time decay'], score: 78 } };
  const a = await optionTrader.consider(s, blocked);
  assert.match(a.skipped, /blocked/);
  await optionTrader.consider(s, blocked);
  const rows = await AutoLog.find({ user: uid, segment: 'OPT', decision: 'SKIPPED' }).lean();
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /sideways/);
  const quiet = await optionTrader.consider(s, { ...read, best: null, lead: { ...read.best, score: 40, blocked: [] } });
  assert.equal(quiet.skipped, 'no setup');
  assert.equal(await AutoLog.countDocuments({ user: uid, segment: 'OPT' }), 1, 'a quiet market is not a decision');
});

test('the options API: settings, the chart read, the log, and a manual buy', async () => {
  const fresh = await registerUser(app);
  const off = (await api().get('/api/options').set(fresh.auth).expect(200)).body;
  assert.equal(off.settings.enabled, false);
  assert.equal(off.settings.budget, 30000);
  assert.match(off.disclaimer, /paper/i);
  assert.deepEqual(off.rules, { stopLoss: 500, lockStart: 1000, lockGap: 100 }, 'the stop and lock come from the Account tab');
  assert.equal(off.settings.lockLadder, undefined);
  assert.equal(off.settings.trailPct, undefined);
  const on = (await api().put('/api/options').set(fresh.auth).send({ enabled: true, maxLots: 1 }).expect(200)).body;
  assert.equal(on.settings.enabled, true);
  assert.equal(on.settings.maxLots, 1);
  await api().put('/api/options').set(fresh.auth).send({ minScore: 10 }).expect(400);
  await api().put('/api/options').set(fresh.auth).send({ enabled: false }).expect(200);

  const read = (await api().get('/api/options/read').set(fresh.auth).expect(200)).body;
  assert.equal(read.ready, true);
  assert.ok(read.ce.score >= 0 && read.pe.checks.length > 10);
  assert.ok(read.contracts.CE.ltp > 0 && read.contracts.PE.lotSize === 65);
  for (const t of ['CE', 'PE']) assert.ok(read.preview[t].plan ? read.preview[t].plan.lockStart === 1000 && read.preview[t].plan.stopLoss > 0 : read.preview[t].skipped, 'every side shows its plan or why there is none');

  const bought = await api().post('/api/options/buy').set(fresh.auth).send({ type: 'CE', lots: 1 });
  assert.ok([201, 400].includes(bought.status), `status ${bought.status}`);
  if (bought.status === 400) assert.match(bought.body.error.message, /Not bought/);
  else assert.equal(bought.body.order.segment, 'OPT');
  await api().post('/api/options/buy').set(fresh.auth).send({ type: 'XX' }).expect(400);

  const log = (await api().get('/api/options/log').set(fresh.auth).expect(200)).body;
  assert.ok(Array.isArray(log.entries) && log.summary);
  await api().get('/api/options/log?day=bad').set(fresh.auth).expect(400);
  await api().post('/api/positions/exit-all').set(fresh.auth).expect(200);
});

test('the share auto log does not show option rows', async () => {
  const fresh = await registerUser(app);
  const uid = fresh.user.id || fresh.user._id;
  const s = (await OptionSettings.create({ user: uid, enabled: true })).toObject();
  await optionTrader.consider(s, callRead(25000));
  await api().post('/api/positions/exit-all').set(fresh.auth).expect(200);
  const shares = (await api().get('/api/auto/log').set(fresh.auth).expect(200)).body;
  assert.equal(shares.entries.length, 0);
  const opts = (await api().get('/api/options/log').set(fresh.auth).expect(200)).body;
  assert.equal(opts.entries.length, 1);
});

test('an option bought by hand is not closed by the 15:00 cut-off or the stall rule, but the auto trader\'s own trades still are', async () => {
  const fresh = await registerUser(app);
  const uid = fresh.user.id || fresh.user._id;
  ctx.provider.setPrice('NIFTY 50', 25000);
  await settle();
  await OptionSettings.create({ user: uid, enabled: false });
  const hand = new OptionTrader({ market: ctx.market, engine: ctx.engine, config: ctx.config });
  hand.read = async () => {
    const rd = callRead(25000);
    return { ...rd, ce: rd.best }; // the side the Buy button uses
  };
  const r = await hand.enterManually(uid, 'CE', 1);
  assert.ok(r.order, r.skipped);
  const row = await AutoLog.findOne({ user: uid, segment: 'OPT', decision: 'PLACED' }).lean();
  assert.equal(row.detail.manual, true);

  // 15:05 IST, and then 40 minutes of going nowhere: neither closes a hand-bought trade
  const late = new OptionTrader({ market: ctx.market, engine: ctx.engine, config: ctx.config, now: () => new Date(Date.UTC(2026, 9, 26, 9, 35)) });
  await late.init();
  late.start();
  try {
    await late.manage(uid);
    await sleep(100);
    assert.equal((await Position.findOne({ user: uid, symbol: r.plan.symbol })).status, 'OPEN');
  } finally {
    late.stop();
  }
  await ctx.engine.exitPosition(uid, r.plan.symbol);
});
