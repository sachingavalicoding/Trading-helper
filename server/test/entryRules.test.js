import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmEntry, rLadder, ruleBlock, shareRulesOf, DEFAULT_SHARE_RULES } from '../src/scanner/entryRules.js';
import { niftyTrendOf, niftyTrendTimeline } from '../src/scanner/marketTrend.js';
import { ruleTest, tradesFor } from '../src/study/ruleTest.js';
import { runSharesStudy } from '../src/study/sharesStudy.js';
import { whatWins } from '../src/scanner/stats.js';
import { buildDayReport, shareRulesText } from '../src/report/dayReport.js';

// 10:00 IST on 9 Nov 2026, on a 5-minute boundary
const T0 = Date.UTC(2026, 10, 9, 4, 30) / 1000;
const bar = (m, close, { high = close + 0.2, low = close - 0.2 } = {}) => ({ time: T0 + m * 60, open: close, high, low, close, volume: 1000 });

function walk(nDays, seed = 11, drift0 = 0, volume = 0) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const out = [];
  let price = 1000;
  let t0 = Date.UTC(2026, 9, 5, 3, 45) / 1000;
  for (let d = 0; d < nDays; t0 += 86400) {
    const wd = new Date(t0 * 1000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    let drift = 0;
    for (let m = 0; m < 375; m++) {
      if (m % 60 === 0) drift = drift0 + (rnd() - 0.5) * 0.4;
      const o = price;
      const c = o + drift + (rnd() - 0.5) * 2;
      out.push({ time: t0 + m * 60, open: o, high: Math.max(o, c) + rnd(), low: Math.min(o, c) - rnd(), close: c, volume: volume ? Math.round(volume * (0.5 + rnd())) : 0 });
      price = c;
    }
    d += 1;
  }
  return out;
}

test('share rules: defaults keep the old behaviour, saved values win, a missing reading never blocks', () => {
  assert.deepEqual(shareRulesOf(null), { ...DEFAULT_SHARE_RULES });
  assert.equal(shareRulesOf({ minStopPct: 0.3 }).minStopPct, 0.3);
  assert.equal(shareRulesOf({ minStopPct: 0.3 }).noChaseR, 0.5);
  const on = shareRulesOf({ marketAgree: true, minVsNifty: 0.3, minRelVol: 1.2 });
  assert.equal(ruleBlock(on, { niftyTrend: 1, relStrength: 0.5, relVol: 1.5 }, 'BUY'), null);
  assert.match(ruleBlock(on, { niftyTrend: 0, relStrength: 0.5, relVol: 1.5 }, 'BUY'), /sideways/);
  assert.match(ruleBlock(on, { niftyTrend: 1, relStrength: 0.5, relVol: 1.5 }, 'SELL'), /against this sell/);
  assert.match(ruleBlock(on, { niftyTrend: 1, relStrength: 0.1, relVol: 1.5 }, 'BUY'), /stronger/);
  assert.equal(ruleBlock(on, { niftyTrend: -1, relStrength: -0.4, relVol: 2 }, 'SELL'), null, 'a sell needs the share weaker than Nifty');
  assert.match(ruleBlock(on, { niftyTrend: 1, relStrength: 0.5, relVol: 0.9 }, 'BUY'), /volume/);
  assert.equal(ruleBlock(on, {}, 'BUY'), null);
  assert.equal(ruleBlock(shareRulesOf(null), { niftyTrend: -1, relStrength: -2, relVol: 0.1 }, 'BUY'), null, 'all off by default');
  assert.match(shareRulesText(shareRulesOf(null)), /buys when the idea appears, no buy once 0.5R past the entry, smallest stop 0.5%/);
});

test('wait for a 5-minute close: buys at the close past the entry, drops a spike that falls back, a touched stop, or a close too far away', () => {
  const idea = { side: 'BUY', entry: 100, stopLoss: 99 };
  // raised at 10:01; the 10:00 bar closes at 100.3 (10:04 close): buy there
  const good = [bar(0, 99.9), bar(1, 100), bar(2, 100.2), bar(3, 100.1), bar(4, 100.3), bar(5, 100.4)];
  assert.deepEqual(confirmEntry(good, 1, idea), { index: 4, price: 100.3, time: T0 + 240 });
  assert.deepEqual(confirmEntry(good.slice(0, 5), 1, idea), { waiting: true }, 'the bar is not closed until the next one starts');
  // closes under the entry twice: dropped after 10 minutes
  const weak = Array.from({ length: 12 }, (_, m) => bar(m, m === 1 ? 100 : 99.6));
  assert.match(confirmEntry(weak, 1, idea).dropped, /no 5-minute bar closed above the entry within 10 minutes/);
  // first bar closes under, second closes above: bought on the second
  const second = Array.from({ length: 11 }, (_, m) => bar(m, m < 5 ? 99.7 : 100.2));
  assert.equal(confirmEntry(second, 1, idea).index, 9);
  const stopped = [bar(0, 100), bar(1, 100), bar(2, 99.5, { low: 98.9 }), bar(3, 100.4), bar(4, 100.4), bar(5, 100.4)];
  assert.match(confirmEntry(stopped, 1, idea).dropped, /stop was touched/);
  const ran = [bar(0, 100), bar(1, 100), bar(2, 100.4), bar(3, 100.5), bar(4, 100.8), bar(5, 100.8)];
  assert.match(confirmEntry(ran, 1, idea).dropped, /already 0.80R past/);
  const sell = { side: 'SELL', entry: 100, stopLoss: 101 };
  const down = [bar(0, 100), bar(1, 100), bar(2, 99.9), bar(3, 99.8), bar(4, 99.7), bar(5, 99.6)];
  assert.equal(confirmEntry(down, 1, sell).price, 99.7);
});

test('Nifty trend: an index without volume still gets a direction, and the study timeline matches the live reading', () => {
  const up = walk(3, 5, 0.3);
  const down = walk(3, 5, -0.3);
  assert.equal(niftyTrendOf(up), 1);
  assert.equal(niftyTrendOf(down), -1);
  const tl = niftyTrendTimeline(up);
  let same = 0;
  let n = 0;
  for (let i = 400; i < up.length; i += 13) {
    n++;
    if (tl(up[i].time)?.niftyTrend === niftyTrendOf(up.slice(0, i + 1))) same++;
  }
  assert.ok(same / n > 0.95, `${same}/${n}`);
  assert.equal(tl(up[0].time), null, 'no reading before enough history');
});

const idea = (over) => ({
  setup: 'Opening range breakout',
  side: 'BUY',
  score: 85,
  entry: 1000,
  stopLoss: 994,
  target1: 1012,
  openedAt: '2026-11-09T05:00:00.000Z',
  status: 'STOPPED',
  exit: 'STOP',
  exitPrice: 994,
  exitTime: Date.parse('2026-11-09T05:30:00Z') / 1000,
  sizedQty: 50,
  facts: { niftyTrend: 1, relStrength: 0.5, relVol: 1.5, stopPct: 0.6 },
  targets: { 200: { status: 'TARGET_HIT', exit: 'TARGET', exitPrice: 1004, exitTime: Date.parse('2026-11-09T05:10:00Z') / 1000, sizedQty: 50 } },
  confirmed: { dropped: 'no close' },
  ...over,
});

test('profit lock in risks: rupee rows from the risk of each trade, nearest ladder, off at 0', () => {
  assert.deepEqual(rLadder(0.5, 300), [{ at: 150, keep: 75 }, { at: 225, keep: 135 }, { at: 300, keep: 210 }, { at: 450, keep: 345 }]);
  assert.deepEqual(rLadder(0.4, 1000)[0], { at: 350, keep: 200 }, '0.4 picks the 0.35 ladder');
  assert.deepEqual(rLadder(0, 300), []);
  assert.match(shareRulesText(shareRulesOf({ lockFromR: 0.5 })), /profit lock in risks from \+0.5R/);
});

test('rule test: each rule filters the same ideas, a rule is better only when both halves agree, and the patch is what to save', () => {
  const days = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const ideas = [];
  for (const d of days) {
    for (let k = 0; k < 4; k++) {
      // the Nifty-against ideas always lose, the Nifty-with ideas win
      const withNifty = k < 2;
      ideas.push(idea({ openedAt: `${d}T0${4 + k}:00:00.000Z`, exitTime: Date.parse(`${d}T0${4 + k}:30:00Z`) / 1000, facts: { niftyTrend: withNifty ? 1 : -1, relStrength: 0.4, relVol: 1.5, stopPct: 0.6 }, ...(withNifty ? { status: 'LOCKED', exit: 'LOCK', exitPrice: 1006 } : {}) }));
    }
  }
  const settings = { minScore: 80, skipSetups: [], shareRules: {} };
  const r = ruleTest(ideas, settings, { riskAmount: 300, slippagePct: 0.05 });
  assert.equal(r.now.trades, 16);
  const market = r.rows.find((x) => x.key === 'marketAgree');
  assert.equal(market.trades, 8);
  assert.ok(market.totalNet > r.now.totalNet);
  assert.equal(market.verdict, 'few', 'only 8 trades: too few to call');
  assert.deepEqual(market.patch, { marketAgree: true });
  const vs = r.rows.find((x) => x.key === 'minVsNifty');
  assert.equal(vs.trades, 16, '0.4% stronger passes the 0.3% rule');
  assert.equal(r.rows.find((x) => x.key === 'confirmBar').trades, 0, 'every confirmation was dropped');
  const t200 = r.rows.find((x) => x.key === 'target200');
  assert.deepEqual(t200.patch, { target: 200 });
  assert.equal(t200.verdict, 'better');
  // stop after 2 losses: the 3rd and 4th trade of each day come after 0 losses (the first two win), so nothing changes
  assert.equal(r.rows.find((x) => x.key === 'stopAfterLosses').trades, 16);
  // the setups you switched off and the minimum score count
  assert.equal(tradesFor(ideas, { minScore: 90, setupOn: () => true, rules: shareRulesOf(null) }).length, 0);
  assert.equal(ruleTest(ideas, { ...settings, skipSetups: ['Opening range breakout'] }, { riskAmount: 300 }).now.trades, 0);
  // the last entry time: ideas at 04:00-07:00 UTC are 09:30-12:30 IST
  const until1130 = r.rows.find((x) => x.key === 'until1130');
  assert.equal(until1130.trades, 8, 'only the 09:30 and 10:30 ideas');
  assert.deepEqual(until1130.body, { entryTo: 690 });
  assert.deepEqual(t200.body, { shareRules: { target: 200 } });
  // a lock in risks uses the replay's own outcome for it
  const locked = ideas.map((i) => ({ ...i, rlocks: { 0.5: { status: 'LOCKED', exit: 'LOCK', exitPrice: 1003, exitTime: i.exitTime, sizedQty: 50 }, 0.35: { status: 'STOPPED', exit: 'STOP', exitPrice: 994, exitTime: i.exitTime, sizedQty: 50 } } }));
  const lr = ruleTest(locked, settings, { riskAmount: 300, slippagePct: 0.05 });
  assert.ok(lr.rows.find((x) => x.key === 'lockR05').totalNet > 0);
  assert.deepEqual(lr.rows.find((x) => x.key === 'lockR05').body, { shareRules: { lockFromR: 0.5 } });
  assert.ok(lr.rows.find((x) => x.key === 'lockR035').totalNet < 0);
  // a rule already on says so
  assert.equal(ruleTest(ideas, { ...settings, shareRules: { marketAgree: true } }, { riskAmount: 300 }).rows.find((x) => x.key === 'marketAgree').verdict, 'on');
});

test('the shares study also tests the new entry rules on the ideas the live scanner would raise', async () => {
  const history = { AAA: walk(12, 3, 0, 5000), BBB: walk(12, 5, 0, 5000), CCC: walk(12, 8, 0.05, 5000) };
  const r = await runSharesStudy({ nifty1: walk(12, 7), history, params: { days: 5, riskAmount: 300, maxAmount: 100000, settings: { minScore: 70, skipSetups: [], trendScore: true, shareRules: {} } } });
  const t = r.ruleTest;
  assert.ok(t, 'rule test in the result');
  assert.equal(t.rows.length, 14);
  assert.ok(t.rows.find((x) => x.key === 'lockR05').trades <= t.now.trades);
  assert.ok(t.now.trades >= 0);
  for (const row of t.rows) {
    assert.ok(['better', 'mixed', 'worse', 'few', 'on'].includes(row.verdict), row.verdict);
    assert.ok(row.trades <= t.ideas);
  }
  assert.ok(t.rows.find((x) => x.key === 'marketAgree').trades <= t.now.trades);
});

test('what wins: the track record split by stop size, market, strength and volume, with charges in risks, in the day report', () => {
  const at = (h) => `2026-11-09T0${h}:00:00.000Z`;
  const ideas = [
    { setup: 'Opening range breakout', side: 'BUY', status: 'TARGET_HIT', entry: 100, stopLoss: 99.7, exitPrice: 100.6, openedAt: at(4), bestR: 2, card: { facts: { niftyTrend: 1, relStrength: 0.6, relVol: 2.1 } } },
    { setup: 'Opening range breakout', side: 'BUY', status: 'STOPPED', entry: 100, stopLoss: 99.1, exitPrice: 99.1, openedAt: at(5), bestR: 0.1, card: { facts: { niftyTrend: 0, relStrength: -0.1, relVol: 0.9 } } },
    { setup: 'Trend score', side: 'BUY', status: 'STOPPED', entry: 100, stopLoss: 99.4, exitPrice: 99.4, openedAt: at(5), bestR: 0.8, card: { checks: [{ id: 'strength', points: 8, max: 8 }, { id: 'volume', points: 0, max: 8 }, { id: 'niftyTrend', points: 1, max: 3 }] } },
  ];
  for (let k = 0; k < 4; k++) ideas.push({ symbol: 'LOSER', setup: 'Opening range breakout', side: 'BUY', status: 'STOPPED', entry: 100, stopLoss: 99.4, exitPrice: 99.4, openedAt: at(5) });
  const w = whatWins([...ideas, { ...ideas[1], openedAt: '2026-11-08T19:00:00.000Z' }], { chargesR: () => 0.12 });
  assert.equal(w.outOfHours, 1, 'an idea raised at 00:30 IST is left out');
  assert.equal(w.count, 7);
  assert.equal(w.byShare.worst[0].key, 'LOSER');
  assert.equal(w.byShare.best.length, 0);
  assert.deepEqual(w.byStop.map((g) => g.key).sort(), ['0.5-0.8%', '0.8% or more', 'under 0.4%']);
  assert.ok(w.byMarket.some((g) => g.key === 'Nifty sideways'));
  assert.ok(w.byMarket.some((g) => g.key === 'most shares moving with it'), 'older ideas fall back to the score part');
  assert.equal(w.byVsNifty.find((g) => g.key === '0.5%+ stronger').count, 2);
  assert.deepEqual(w.quickFails, { stopped: 2, neverHalfR: 1 });
  assert.equal(w.soldAtHalfR.avgR, round((0.5 - 1 + 0.5) / 3));
  assert.equal(w.chargesR, 0.12);
  const text = buildDayReport({ day: '2026-11-09', generatedAt: new Date(), market: { provider: 'mock' }, wins: w, settings: { auto: { enabled: true, minScore: 80, maxOpen: 10, dailyLossPct: 10, maxTradeAmount: 100000, shareRules: { marketAgree: true, target: 250 } } } });
  assert.match(text, /## What wins in the track record \(7 finished ideas/);
  assert.match(text, /Charges cost about 0.12R a trade/);
  assert.match(text, /never got \+0.2R first .*: 1 of 2/);
  assert.match(text, /Share entry rules: Nifty must agree/);
  assert.match(text, /sell at \+₹250/);
});

const round = (n) => Math.round(n * 100) / 100;
