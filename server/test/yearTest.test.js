import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packCandles } from '../src/market/historyStore.js';
import { YearSource, YearTest, cutDown, summary, checkVerdict, SHARE_SETUPS } from '../src/yeartest/yearTest.js';

const day = (d, p0) => {
  const t0 = Date.parse(`${d}T03:45:00Z`) / 1000;
  const list = Array.from({ length: 375 }, (_, i) => ({ time: t0 + i * 60, open: p0 + i * 0.1, high: p0 + i * 0.1 + 1, low: p0 + i * 0.1 - 1, close: p0 + i * 0.1 + 0.05, volume: 1000 }));
  return { n: list.length, d: packCandles(list).toString('base64') };
};

test('YearSource reads a day once even when two files have it, and only between the days asked', async () => {
  const a = { group: 'nifty', symbols: { 'NIFTY 50': { '2026-01-05': day('2026-01-05', 100), '2026-01-06': day('2026-01-06', 200) } } };
  const b = { group: 'nifty', symbols: { 'NIFTY 50': { '2026-01-06': day('2026-01-06', 999), '2026-01-07': day('2026-01-07', 300) } } };
  const src = new YearSource({ yearFiles: { list: async () => [{ name: 'nifty-2026.json.gz' }], load: async () => a }, imports: { list: async () => [{ id: 'x', group: 'nifty' }], object: async () => b } });
  assert.deepEqual(await src.days('nifty'), ['2026-01-05', '2026-01-06', '2026-01-07']);
  const c = await src.candles('nifty', 'NIFTY 50', '2026-01-06', '2026-01-07');
  assert.equal(c.length, 750);
  assert.equal(c[0].open, 200); // the server file wins over the import
});

test('cutDown keeps only the one thing tested and switches the other bot off', () => {
  const docs = { optionsettings: { enabled: false, scoreEntries: false, patternEntries: true, combos: [{ id: 'a', name: 'A', conds: ['emaStack'], need: 1, window: 1 }] }, autosettings: { enabled: true, skipSetups: [], combos: [{ id: 's', name: 'S', conds: ['emaStack'], need: 1, window: 1 }] }, tradedefaults: null };
  const o = cutDown({ side: 'options', what: 'score' }, docs);
  assert.equal(o.optionsettings.scoreEntries, true);
  assert.equal(o.optionsettings.patternEntries, false);
  assert.equal(o.optionsettings.combos[0].on, false);
  assert.equal(o.autosettings.enabled, false);
  const c = cutDown({ side: 'shares', what: 'combo', combo: 's' }, docs);
  assert.deepEqual(c.autosettings.skipSetups, SHARE_SETUPS);
  assert.equal(c.autosettings.combos[0].on, true);
  assert.equal(c.optionsettings.enabled, false);
  const one = cutDown({ side: 'shares', what: 'score', entry: 'VWAP pullback' }, docs);
  assert.ok(!one.autosettings.skipSetups.includes('VWAP pullback'));
  assert.equal(one.autosettings.skipSetups.length, SHARE_SETUPS.length - 1);
  assert.equal(docs.optionsettings.scoreEntries, false); // the copy, never the saved settings
});

test('summary: months, entries, best/worst month, without the best day, untouched days', () => {
  const run = { months: [
    { month: '2026-01', done: true, days: ['2026-01-05', '2026-01-06'], seconds: 10, trades: [{ day: '2026-01-05', entry: 'A', net: 1000 }, { day: '2026-01-06', entry: 'B', net: -200 }] },
    { month: '2026-02', done: true, days: ['2026-02-02'], seconds: 5, trades: [{ day: '2026-02-02', entry: 'A', net: -300 }] },
    { month: '2026-03', done: false, days: ['2026-03-02'], trades: [] },
  ] };
  const s = summary(run, '2026-02-01');
  assert.equal(s.trades, 3);
  assert.equal(s.net, 500);
  assert.equal(s.winRate, 33);
  assert.equal(s.bestMonth.key, '2026-01');
  assert.equal(s.worstMonth.key, '2026-02');
  assert.equal(s.withoutBestDay, -500);
  assert.equal(s.untouched.trades, 2);
  assert.equal(s.untouched.net, 800);
  assert.equal(s.days, 3);
  assert.equal(s.secondsPerDay, 5);
  assert.deepEqual(s.perEntry.map((e) => [e.key, e.net]), [['B', -200], ['A', 700]].reverse());
});

test('checkVerdict trusts the fast mode only when it is close to the full Replay', () => {
  assert.equal(checkVerdict([{ day: 'd', fast: { trades: 4, net: 1000 }, full: { trades: 4, net: 800 } }]).trusted, true);
  assert.equal(checkVerdict([{ day: 'd', fast: { trades: 10, net: 5000 }, full: { trades: 3, net: -900 } }]).trusted, false);
  assert.equal(checkVerdict([{ day: 'd', fast: { trades: 1, net: 1 }, full: null }]).trusted, null);
});

test('playDays: a share combination over synthetic year files gives trades on the days asked only', async () => {
  const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16'];
  const mk = (p) => Object.fromEntries(days.map((d, i) => [d, day(d, p + i * 3)]));
  const { NIFTY50 } = await import('../src/market/instruments.js');
  const nifty = { group: 'nifty', symbols: { 'NIFTY 50': mk(24000) } };
  const shares = { group: 'shares', symbols: Object.fromEntries(NIFTY50.slice(0, 5).map((s, i) => [s.symbol, mk(500 + i * 50)])) };
  const yt = new YearTest({ dir: '/tmp/yt-test', yearFiles: { list: async () => [{ name: 'nifty-2026.json.gz' }, { name: 'shares-2026.json.gz' }], load: async (g) => (g === 'nifty' ? nifty : shares) }, imports: { list: async () => [] }, lab: null });
  const combo = { id: 'c1', name: 'Up', conds: ['aboveEma20'], need: 1, window: 1 };
  const run = { spec: { side: 'shares', what: 'combo', combo: 'c1', comboName: 'Up' }, engine: { params: { combos: [combo], riskAmount: 500, steps: [], exitMin: 915, slippagePct: 0.05, maxAmount: 30000, maxOpen: 2, dailyLoss: 0 } } };
  const trades = await yt.playDays(run, days.slice(5));
  assert.ok(trades.every((t) => days.slice(5).includes(t.day)));
  assert.ok(trades.every((t) => Number.isFinite(t.net)));
});

test('cutDown: score bot with up to 2 combinations and a test-only trades-a-day cap', () => {
  const docs = { optionsettings: { maxTrades: 8, combos: [{ id: 'a', name: 'A', conds: ['emaStack'], need: 1, window: 1 }, { id: 'b', name: 'B', conds: ['emaStack'], need: 1, window: 1 }, { id: 'c', name: 'C', conds: ['emaStack'], need: 1, window: 1 }] }, autosettings: {}, tradedefaults: null };
  const o = cutDown({ side: 'options', what: 'score', with: ['a', 'c'], maxTrades: 5 }, docs);
  assert.deepEqual(o.optionsettings.combos.map((c) => c.on), [true, false, true]);
  assert.equal(o.optionsettings.maxTrades, 5);
  assert.equal(docs.optionsettings.maxTrades, 8);
});

test('the Replay check gives up after its time limit and stops the Replay copies', async () => {
  const { CandleDay, OptionCandleDay } = await import('../src/models/index.js');
  const { TickChunk } = await import('../src/models/TickChunk.js');
  const days = ['2026-11-18', '2026-11-19'];
  CandleDay.distinct = async () => days;
  OptionCandleDay.distinct = async () => days;
  TickChunk.distinct = async () => [];
  const stops = [];
  const runner = { busy: false, runDay: () => new Promise(() => {}), stop() { stops.push(1); } };
  const ladder = { runners: [runner, runner], job: null };
  const yt = new YearTest({ dir: '/tmp/yt-test', yearFiles: { list: async () => [] }, imports: { list: async () => [] }, lab: null, ladder });
  yt.checkMs = 50;
  yt.source.days = async () => days;
  yt.playDays = async () => [];
  const c = await yt.check2({ userId: 'x', stopped: false }, { spec: { side: 'options', what: 'score', entry: 'all' }, cut: {} });
  assert.match(c.verdict.text, /was stopped/);
  assert.equal(stops.length, 2);
  assert.equal(ladder.borrowed, false);
});

test('Study on year files: without the files the study fails with "Data not found", and ladder needs saved data', async () => {
  const { StudyService } = await import('../src/study/service.js');
  const years = new YearSource({ yearFiles: { list: async () => [] }, imports: { list: async () => [] } });
  const study = new StudyService({ market: { provider: {} }, config: {}, years });
  const uid = '6ad9955f986262870e56129d';
  const job = study.start(uid, 'options', { source: 'year', years: 2 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(job.state, 'failed');
  assert.match(job.error, /Data not found/);
  assert.throws(() => study.start(uid, 'ladder', { source: 'year' }), /saved data/);
});
