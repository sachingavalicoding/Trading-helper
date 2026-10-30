import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { AutoLog, NewsItem, ScanIdea } from '../src/models/index.js';
import { MarketDataService } from '../src/market/MarketDataService.js';
import { MockProvider } from '../src/market/providers/MockProvider.js';
import { ReviewService } from '../src/review/service.js';
import { candleOn, judge, moveOf, morningWindow, prevCloseBefore, sessionAfter, tally } from '../src/review/day.js';
import { setup, teardown, closeDb, registerUser } from './helpers.js';

after(closeDb);

const midnightIst = (dateKey) => Date.parse(`${dateKey}T00:00:00Z`) / 1000 - 19800;
const candle = (dateKey, open, high, low, close) => ({ time: midnightIst(dateKey), open, high, low, close, volume: 1000 });
const DAILY = [candle('2026-10-22', 100, 104, 99, 100), candle('2026-10-23', 101, 106, 100, 105)];

test('moveOf and judge: a buy call that rose is a hit and the dip is measured from the open', () => {
  const move = moveOf(DAILY[1], 100);
  assert.equal(move.gapPct, 1);
  assert.equal(move.openToClosePct, 3.96);
  assert.equal(move.openToHighPct, 4.95);
  assert.equal(move.openToLowPct, -0.99);
  const up = judge(1, move);
  assert.deepEqual(up, { verdict: 'HIT', edgePct: 3.96, bestPct: 4.95, dipPct: -0.99 });
  const down = judge(-1, move);
  assert.equal(down.verdict, 'MISS');
  assert.equal(down.edgePct, -3.96);
  assert.equal(down.bestPct, 0.99);
  assert.equal(down.dipPct, -4.95);
});

test('judge: a day that ends inside 0.15% of its open is flat, not a hit', () => {
  assert.equal(judge(1, moveOf(candle('2026-10-23', 100, 101, 99, 100.1), 100)).verdict, 'FLAT');
  assert.equal(judge(0, moveOf(DAILY[1], 100)), null);
  assert.equal(judge(1, null), null);
});

test('daily helpers find a session by date, the close before it, and the session a headline can first be traded in', () => {
  assert.equal(candleOn(DAILY, '2026-10-23').close, 105);
  assert.equal(candleOn(DAILY, '2026-10-24'), null);
  assert.equal(prevCloseBefore(DAILY, '2026-10-23'), 100);
  // 08:00 IST on the 23rd -> that day's session; 10:00 IST -> too late for it (the next candle, which does not exist here)
  assert.equal(sessionAfter('2026-10-23T02:30:00Z', DAILY).close, 105);
  assert.equal(sessionAfter('2026-10-23T04:30:00Z', DAILY), null);
  const w = morningWindow('2026-10-23');
  assert.equal(w.to.toISOString(), '2026-10-23T03:45:00.000Z');
  assert.equal(w.to - w.from, 24 * 3600_000);
});

test('tally: hit rate counts only decided calls', () => {
  const mk = (verdict, edgePct) => ({ k: 'A', result: { verdict, edgePct, bestPct: 1, dipPct: -0.5 } });
  const [row] = tally([mk('HIT', 2), mk('HIT', 1), mk('MISS', -1), mk('FLAT', 0)], (r) => r.k);
  assert.equal(row.calls, 4);
  assert.equal(row.hitRate, 67);
  assert.equal(row.avgEdgePct, 0.5);
});

test('review routes: a morning headline and a scanner idea are judged against the day, with options and techniques', async () => {
  const ctx = await setup();
  try {
    const now = () => new Date('2026-10-27T10:00:00Z');
    ctx.market.getDaily = async () => DAILY;
    const review = new ReviewService({ market: ctx.market, now });
    const app = createApp({ ...ctx, review });
    const { auth, user } = await registerUser(app);

    await NewsItem.create({ symbol: 'TCS', hash: 'a1', title: 'TCS wins big order', url: 'https://n.test/a', source: 'Mint', publishedAt: new Date('2026-10-23T02:30:00Z'), sentiment: 2, label: 'BULLISH', category: 'ORDER_WIN', reasons: ['New order or contract won'] });
    await NewsItem.create({ symbol: 'TCS', hash: 'a2', title: 'Quiet day at TCS', url: 'https://n.test/b', publishedAt: new Date('2026-10-23T02:00:00Z'), sentiment: 0, label: 'NEUTRAL', category: 'OTHER', reasons: [] });
    await ScanIdea.create({ day: '2026-10-23', symbol: 'TCS', setup: 'VWAP pullback', side: 'BUY', entry: 102, stopLoss: 100, target1: 104, target2: 106, riskReward: 1, score: 78, status: 'TARGET_HIT', exitPrice: 104, bestR: 2, card: { checks: [{ id: 'rsi', label: 'RSI', points: 6, max: 6 }] } });
    await ScanIdea.create({ day: '2026-10-23', symbol: 'INFY', setup: 'Level retest', side: 'SELL', entry: 102, stopLoss: 103, target1: 100, target2: 99, riskReward: 1, score: 72, status: 'STOPPED', exitPrice: 103, bestR: 0.2, card: { checks: [{ id: 'rsi', label: 'RSI', points: 0, max: 6 }] } });
    await AutoLog.create({ user: user.id, day: '2026-10-23', symbol: 'NIFTY26OCT25000CE', segment: 'OPT', side: 'BUY', decision: 'PLACED', status: 'CLOSED', score: 75, detail: { type: 'CE', label: 'Nifty 25000 CE', spot: 25000 }, outcome: { exitReason: 'LOCK', netPnl: 420, grossPnl: 450, charges: 30, resultR: 1.2 } });

    const day = (await request(app).get('/api/review/day?day=2026-10-23').set(auth).expect(200)).body;
    const tcs = day.stocks.find((s) => s.symbol === 'TCS');
    assert.equal(tcs.news.label, 'BULLISH');
    assert.equal(tcs.news.result.verdict, 'HIT');
    assert.equal(tcs.news.url, 'https://n.test/a');
    assert.equal(tcs.ideas[0].result.verdict, 'HIT');
    assert.equal(tcs.ideas[0].family, 'Trend follow');
    const infy = day.stocks.find((s) => s.symbol === 'INFY');
    assert.equal(infy.news, null);
    assert.equal(infy.ideas[0].result.verdict, 'MISS'); // a sell call on a day that rose
    assert.equal(day.summary.news.hits, 1);
    assert.equal(day.summary.ideas.targets, 1);
    assert.equal(day.summary.ideas.stopped, 1);
    assert.equal(day.summary.bestCall.symbol, 'TCS');
    assert.equal(day.nifty.ifCallAtOpen.closePct, 3.96);
    assert.equal(day.nifty.ifPutAtOpen.closePct, -3.96);
    assert.equal(day.options.entries[0].type, 'CE');
    assert.equal(day.options.entries[0].niftyAgreed, 'HIT');
    assert.equal(day.options.summary.netPnl, 420);

    const tech = (await request(app).get('/api/review/techniques?days=30').set(auth).expect(200)).body;
    assert.equal(tech.scanner.overall.count, 2);
    assert.equal(tech.scanner.byFamily.find((f) => f.key === 'Trend follow').winRate, 100);
    const rsi = tech.scanner.byCheck.find((c) => c.id === 'rsi');
    assert.equal(rsi, undefined); // needs 5 ideas with the check before it says anything
    assert.equal(tech.trades.options.netPnl, 420);
    assert.equal(tech.news.byCategory.find((c) => c.key === 'ORDER_WIN').hits, 1);

    await request(app).get('/api/review/day?day=bad').set(auth).expect(400);
    await request(app).get('/api/review/stock/NOPE').set(auth).expect(404);
    const stock = (await request(app).get('/api/review/stock/TCS?day=2026-10-23').set(auth).expect(200)).body;
    assert.equal(stock.move.close, 105);
    const headline = stock.news.find((n) => n.title === 'TCS wins big order');
    assert.equal(headline.timing, 'BEFORE_OPEN');
    assert.equal(headline.agreed, true);
    assert.equal(headline.moveToClosePct, 3.96);
    assert.equal(stock.news.find((n) => n.title === 'Quiet day at TCS').agreed, null);
    assert.equal(stock.ideas.length, 1);
    await request(app).get('/api/review/day').expect(401);

    // the Sensex has a chart of its own, and both indexes can be asked for patterns and combinations
    const sensexStock = (await request(app).get('/api/review/stock/SENSEX?day=2026-10-23').set(auth).expect(200)).body;
    assert.equal(sensexStock.name, 'Sensex');
    assert.equal((await request(app).get('/api/review/patterns?day=2026-10-23').set(auth).expect(200)).body.index, 'NIFTY');
    assert.equal((await request(app).get('/api/review/patterns?day=2026-10-23&index=SENSEX').set(auth).expect(200)).body.index, 'SENSEX');
    await request(app).get('/api/review/patterns?day=2026-10-23&index=DAX').set(auth).expect(400);
  } finally {
    await teardown(ctx);
  }
});

test('the market status tells the app whether orders are refused outside market hours', () => {
  const quiet = () => new MockProvider({ intervalMs: 10_000_000 });
  assert.equal(new MarketDataService(quiet()).status().market.enforced, false);
  assert.equal(new MarketDataService(quiet(), { enforceHours: true }).status().market.enforced, true);
});
