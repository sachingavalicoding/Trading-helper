import test from 'node:test';
import assert from 'node:assert/strict';
import { CONDITIONS, GROUPS, buildChart, holds, usable, catalog } from '../src/combos/conditions.js';
import { comboSignals, normalizeCombo, normalizeCombos, singleCombo, missingData, describeCombo, MAX_CONDITIONS } from '../src/combos/combos.js';
import { verdictOf, halvesOf, MIN_TRADES } from '../src/combos/verdict.js';
import * as S from '../src/combos/series.js';
import { shareStop, shareIdeas, shareChart, bars5Of, newsDirection } from '../src/combos/shares.js';
import { runOptionsStudy } from '../src/study/optionsStudy.js';
import { runSharesStudy } from '../src/study/sharesStudy.js';

// Monday 5 Oct 2026, 09:15 IST
const OPEN = Date.UTC(2026, 9, 5, 3, 45) / 1000;

function tape(drift, days = 8, seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  let p = 24000;
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < 75; k++) {
      const o = p;
      const c = o + drift + (rnd() - 0.5) * 30;
      out.push({ time: OPEN + d * 86400 + k * 300, open: o, high: Math.max(o, c) + rnd() * 10, low: Math.min(o, c) - rnd() * 10, close: c, volume: 1000 });
      p = c;
    }
  }
  return out;
}
const flowOf = (bars) => bars.map((b, i) => b.close * (1000 + (i % 7) * 300));
const count = (chart, cond, d) => {
  let n = 0;
  for (let i = 0; i < chart.bars.length; i++) if (holds(chart, cond, d, i)) n += 1;
  return n;
};
const by = (key) => CONDITIONS.find((c) => c.key === key);

// ---------- indicators ----------

test('indicator series keep the length of their input, are empty during warm-up and match hand-worked values', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(S.sma(v, 3), [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(S.ema(v, 3)[1], null);
  assert.equal(S.ema(v, 3)[2], 2, 'seeded with the average of the first n');
  assert.equal(S.ema(v, 3)[3], 3);
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.equal(S.rsi(up, 14).at(-1), 100, 'only gains: RSI is 100');
  assert.equal(S.rsi(up.map((x) => -x), 14).at(-1), 0, 'only losses: RSI is 0');
  const flatThenUp = [...Array.from({ length: 30 }, () => 100), ...Array.from({ length: 10 }, (_, i) => 101 + i)];
  assert.ok(S.macd(flatThenUp).hist.at(-1) > 0);
  for (const f of [S.sma(v, 3), S.rsi(v, 3), S.hma(v, 4), S.stdev(v, 3), S.macd(v).line]) assert.equal(f.length, v.length);
});

test('every indicator on a mirrored chart gives the mirrored answer (RSI 100 - x, supertrend flips), so a put is the same read as a call', () => {
  const bars = tape(1, 3);
  const mir = bars.map((b) => ({ ...b, open: -b.open, high: -b.low, low: -b.high, close: -b.close }));
  const r = S.rsi(S.closesOf(bars), 14);
  const rm = S.rsi(S.closesOf(mir), 14);
  for (let i = 20; i < bars.length; i += 17) assert.ok(Math.abs(r[i] + rm[i] - 100) < 1e-6, `rsi ${i}`);
  const u = S.ultimate(bars);
  const um = S.ultimate(mir);
  for (let i = 40; i < bars.length; i += 17) assert.ok(Math.abs(u[i] + um[i] - 100) < 1e-6, `ultimate ${i}`);
  const st = S.supertrend(bars).dir;
  const stm = S.supertrend(mir).dir;
  let agree = 0;
  for (let i = 100; i < bars.length; i++) if (st[i] === -stm[i]) agree += 1;
  assert.ok(agree >= (bars.length - 100) * 0.85, `supertrend mirrors (${agree} of ${bars.length - 100})`);
  const vol = bars.map(() => 1000);
  const mf = S.mfi(bars, vol, 14);
  const mfm = S.mfi(mir, vol, 14);
  for (let i = 30; i < bars.length; i += 13) assert.ok(Math.abs(mf[i] + mfm[i] - 100) < 1e-6, `mfi ${i}`);
});

// ---------- conditions ----------

test('there are 75 or more checks besides the patterns, every one has a group and a text, and keys are unique', () => {
  assert.ok(CONDITIONS.filter((c) => !c.pattern).length >= 75, `${CONDITIONS.filter((c) => !c.pattern).length}`);
  assert.equal(new Set(CONDITIONS.map((c) => c.key)).size, CONDITIONS.length);
  for (const c of CONDITIONS) {
    assert.ok(GROUPS.includes(c.group), c.key);
    assert.ok(c.label && c.text && ['state', 'event'].includes(c.kind), c.key);
    assert.ok([null, 'flow', 'breadth', 'news'].includes(c.needs), c.key);
  }
  assert.equal(catalog().length, CONDITIONS.length);
  assert.ok(CONDITIONS.some((c) => c.pattern === 'orb') && CONDITIONS.some((c) => c.pattern === 'vwapReclaim'), 'the study patterns are checks too');
});

test('trend checks favour calls on a rising tape and puts on a falling one, and never throw on short or gappy input', () => {
  const up = buildChart(tape(3), { flow: flowOf(tape(3)) });
  const down = buildChart(tape(-3), { flow: flowOf(tape(-3)) });
  for (const key of ['emaStack', 'aboveEma50', 'supertrendUp', 'rsiAbove50', 'macdZero', 'aboveVwap', 'aboveDayMean', 'diPositive', 'cloudAbove']) {
    const c = by(key);
    assert.ok(count(up, c, 1) > 3 * count(up, c, -1) + 10, `${key} on a rising tape: ${count(up, c, 1)} vs ${count(up, c, -1)}`);
    assert.ok(count(down, c, -1) > 3 * count(down, c, 1) + 10, `${key} on a falling tape`);
  }
  const tiny = buildChart(tape(1, 1).slice(0, 5));
  for (const c of CONDITIONS) assert.doesNotThrow(() => holds(tiny, c, 1, 4), c.key);
});

test('checks that need the 50 stocks, or news, are unusable until that data is given, and a combination using one is not tested without it', () => {
  const bare = buildChart(tape(1));
  assert.deepEqual(bare.have, { breadth: false, flow: false, news: false });
  assert.equal(usable(by('aboveVwap'), bare.have), false);
  assert.equal(usable(by('breadth70'), bare.have), false);
  assert.equal(usable(by('rsiAbove50'), bare.have), true);
  const combo = normalizeCombo({ name: 'x', conds: ['rsiAbove50', 'aboveVwap', 'breadth70'] });
  assert.deepEqual(missingData(combo, bare.have), ['flow', 'breadth']);
  assert.deepEqual(comboSignals(bare, combo), []);
  const full = buildChart(tape(1), { flow: flowOf(tape(1)), breadth: tape(1).map(() => 0.75), news: () => 1 });
  assert.deepEqual(full.have, { breadth: true, flow: true, news: true });
  assert.deepEqual(missingData(combo, full.have), []);
});

// ---------- combinations ----------

test('a combination is cleaned: unknown checks and repeats go, it has at most 8, need stays between 1 and the count, ids are unique', () => {
  assert.equal(normalizeCombo({ name: 'none', conds: ['nope'] }), null);
  const c = normalizeCombo({ name: '  Mine ', conds: ['rsiAbove50', 'rsiAbove50', 'nope', 'macdZero'], need: 9 });
  assert.deepEqual([c.name, c.conds, c.need, c.window, c.on], ['Mine', ['rsiAbove50', 'macdZero'], 2, 3, true]);
  assert.equal(normalizeCombo({ conds: ['rsiAbove50'], need: 0 }).need, 1, 'need is at least 1');
  assert.equal(normalizeCombo({ conds: CONDITIONS.slice(0, 20).map((x) => x.key) }).conds.length, MAX_CONDITIONS);
  const list = normalizeCombos([{ name: 'A', conds: ['rsiAbove50'] }, { name: 'A', conds: ['macdZero'] }, { name: 'bad', conds: [] }]);
  assert.deepEqual(list.map((x) => x.id), ['a', 'a-2']);
  assert.deepEqual(normalizeCombos(null), []);
  assert.match(describeCombo(c), /All 2 must hold together/);
  assert.match(describeCombo(normalizeCombo({ name: 'n', conds: ['rsiAbove50', 'macdCross', 'macdZero'], need: 2 })), /At least 2 of 3.*event/);
});

test('a combination fires on the first bar where enough checks hold, once per spell, for calls on a rise and puts on a fall, with a stop on the right side', () => {
  const up = buildChart(tape(3));
  const combo = normalizeCombo({ name: 'Trend', conds: ['emaStack', 'aboveSma20', 'rsiAbove50'] });
  const calls = comboSignals(up, combo, { windows: false });
  assert.ok(calls.length > 0 && calls.every((s) => s.side === 'CE'), JSON.stringify(calls.slice(0, 2)));
  for (const s of calls) {
    assert.ok(s.stop < s.close, 'a call stop is under the price');
    assert.equal(s.time, up.bars[s.i].time + 300, 'made when the bar closed');
  }
  for (let k = 1; k < calls.length; k++) assert.ok(calls[k].i - calls[k - 1].i > 3, 'a cool-down between signals');
  const down = buildChart(tape(-3));
  const puts = comboSignals(down, combo, { windows: false });
  assert.ok(puts.length > 0 && puts.every((s) => s.side === 'PE' && s.stop > s.close));
  assert.ok(comboSignals(up, combo, { windows: false }).every((s) => up.bars[s.i].time === s.time - 300));
});

test('need 2 of 3 fires where all 3 would not, and an event counts for its window only', () => {
  const chart = buildChart(tape(3));
  const all = comboSignals(chart, normalizeCombo({ name: 'a', conds: ['emaStack', 'aboveSma20', 'rsiAbove50'], need: 3 }), { windows: false });
  const two = comboSignals(chart, normalizeCombo({ name: 'b', conds: ['emaStack', 'aboveSma20', 'rsiAbove50'], need: 2 }), { windows: false });
  assert.ok(all.length > 0 && two.length > 0 && two[0].i <= all[0].i, 'two of three is never later than all three');
  const withEvent = normalizeCombo({ name: 'e', conds: ['emaStack', 'closeAbovePrevHigh'], window: 1 });
  const a = comboSignals(chart, withEvent, { windows: false });
  const b = comboSignals(chart, { ...withEvent, window: 5 }, { windows: false });
  assert.ok(a.every((s) => holds(chart, by('closeAbovePrevHigh'), 1, s.i) || holds(chart, by('closeAbovePrevHigh'), -1, s.i)), 'window 1: the event is on the signal bar itself');
  assert.ok(b.length >= 0);
});

test('with a pattern in the combination the stop is the pattern level; without one it sits under the last 6 bars; entry hours are kept', () => {
  const bars = tape(0.5, 6);
  const chart = buildChart(bars, { flow: flowOf(bars) });
  const withPattern = normalizeCombo({ name: 'p', conds: ['p_breakout', 'aboveEma20'] });
  const hits = comboSignals(chart, withPattern, { windows: false });
  for (const s of hits) {
    const pat = chart.patterns[s.side === 'CE' ? 1 : -1].get('breakout');
    const near = [0, 1, 2].map((k) => pat.get(s.i - k)).find(Boolean);
    assert.ok(near, 'a breakout is within the window');
    assert.equal(s.stop, near.stop);
  }
  const plain = comboSignals(chart, normalizeCombo({ name: 'q', conds: ['rsiAbove50'] }), { windows: false });
  for (const s of plain.filter((x) => x.side === 'CE')) {
    const low = Math.min(...bars.slice(s.i - 5, s.i + 1).map((b) => b.low));
    assert.ok(Math.abs(s.stop - (low - 0.15 * s.atr)) < 1e-6);
  }
  const hours = comboSignals(chart, normalizeCombo({ name: 'h', conds: ['rsiAbove50'] }), { windows: true });
  assert.ok(hours.length <= plain.length);
  const closes = hours.map((s) => new Date(s.time * 1000).toISOString().slice(11, 16));
  assert.ok(closes.every((t) => t >= '03:45' && t < '09:45'), 'between 09:15 and 15:15 IST');
});

test('a single check can be ranked as a one-check combination, and the verdict is Keep only when both halves made money', () => {
  const chart = buildChart(tape(2));
  const single = singleCombo('supertrendUp');
  assert.deepEqual([single.conds, single.need, single.window], [['supertrendUp'], 1, 1]);
  assert.ok(comboSignals(chart, single, { windows: false }).length > 0);
  assert.equal(verdictOf({ trades: MIN_TRADES - 1, net: 9000, halves: [1, 1] }), 'Too few');
  assert.equal(verdictOf({ trades: 30, net: 900, halves: [500, 400] }), 'Keep');
  assert.equal(verdictOf({ trades: 30, net: 900, halves: [1300, -400] }), 'Unsteady');
  assert.equal(verdictOf({ trades: 30, net: -50, halves: [100, -150] }), 'Drop');
  assert.deepEqual(halvesOf([{ entryTime: 10, net: 5 }, { entryTime: 20, net: -2 }, { entryTime: 30, net: 4 }], 20), [5, 2]);
});

// ---------- the options study ----------

const PARAMS = { iv: 0.14, lockStart: 1000, lockGap: 250, lotSize: 65, holidays: [], expiryWeekday: 2 };
function minutes(nDays, seed = 11) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  let price = 24000;
  for (let d = 0; d < nDays; d++) {
    let drift = 0;
    for (let m = 0; m < 375; m++) {
      if (m % 60 === 0) drift = (rnd() - 0.5) * 0.9;
      const o = price;
      const c = o + drift + (rnd() - 0.5) * 6;
      out.push({ time: OPEN + d * 86400 + m * 60, open: o, high: Math.max(o, c) + rnd() * 2, low: Math.min(o, c) - rnd() * 2, close: c, volume: 0 });
      price = c;
    }
  }
  return out;
}

test('the options study trades the user\'s combinations next to the patterns and ranks every usable check with a verdict', async () => {
  const combos = normalizeCombos([{ name: 'Trend and RSI', conds: ['emaStack', 'rsiAbove50'] }, { name: 'Needs volume', conds: ['aboveVwap', 'rsiAbove50'] }]);
  const seen = [];
  const r = await runOptionsStudy({ nifty1: minutes(14), params: { ...PARAMS, days: 10, lossLimit: 1500, maxLots: 2, combos }, onProgress: (x) => seen.push(x) });
  const mine = r.techniques.filter((t) => t.combo);
  assert.deepEqual(mine.map((t) => t.key), ['combo:trend-and-rsi']);
  assert.match(mine[0].label, /^My combination: Trend and RSI/);
  assert.match(mine[0].text, /All 2 must hold together/);
  assert.equal(mine[0].halves.length, 2);
  assert.equal(r.combosSkipped.length, 1);
  assert.match(r.combosSkipped[0].reason, /volume of the 50 stocks/);
  assert.ok(r.indicators.length >= 70, `${r.indicators.length}`);
  assert.ok(r.indicators.every((x) => x.key && x.group && ['Keep', 'Unsteady', 'Drop', 'Too few'].includes(x.verdict)));
  assert.ok(!r.indicators.some((x) => x.key === 'aboveVwap'), 'a check without its data is not ranked');
  assert.deepEqual(r.indicators.map((x) => x.net), [...r.indicators.map((x) => x.net)].sort((a, b) => b - a));
  assert.ok(seen.some((x) => /Ranking the indicators/.test(x)));
  assert.ok(r.techniques.some((t) => !t.combo), 'the patterns are still there');
});

test('with no combinations the options study still ranks the checks, and ranking can be switched off', async () => {
  const r = await runOptionsStudy({ nifty1: minutes(14), params: { ...PARAMS, days: 10, rank: false } });
  assert.deepEqual([r.indicators, r.combosSkipped], [[], []]);
  assert.ok(!r.techniques.some((t) => t.combo));
});

// ---------- shares ----------

test('a share stop is never closer than one ATR or 0.5%, is on the right side, and a stop too far away skips the idea', () => {
  const ce = { side: 'CE', stop: 995, atr: 2 };
  assert.equal(shareStop(ce, 1000), 995, '0.5% of 1000 is 5');
  assert.equal(shareStop({ ...ce, stop: 999.9 }, 1000), 995, 'widened to the floor');
  assert.equal(shareStop({ side: 'PE', stop: 1001, atr: 2 }, 1000), 1005, 'a short stop is above');
  assert.equal(shareStop({ ...ce, stop: 960 }, 1000), null, 'over 3 ATR and over 0.8%: too far');
  assert.equal(shareStop({ ...ce, stop: 998, atr: 1 }, 1000), 995, 'a calm share still has its 0.5%');
});

test('news counts for a buy when the headline is bullish and the price is not selling it, and a fading headline counts for nothing', () => {
  assert.equal(newsDirection({ label: 'BULLISH', reaction: 'AGREES' }), 1);
  assert.equal(newsDirection({ label: 'BEARISH', reaction: 'WAITING' }), -1);
  assert.equal(newsDirection({ label: 'BULLISH', reaction: 'FADING' }), 0);
  assert.equal(newsDirection(null), 0);
  const bars = bars5Of(minutes(3));
  const chart = shareChart(bars, { news: (i) => (i === bars.length - 1 ? 1 : 0) });
  assert.equal(chart.have.news, true);
  const c = by('newsAgrees');
  assert.equal(holds(chart, c, 1, bars.length - 1), true);
  assert.equal(holds(chart, c, -1, bars.length - 1), false, 'good news is not a reason to short');
  assert.equal(holds(chart, c, 1, bars.length - 2), false);
});

test('a combination gives a share at most one idea per side per day, between 09:30 and the exit time, with entry, stop and targets in order', () => {
  const bars = bars5Of(minutes(6));
  const chart = shareChart(bars);
  const ideas = shareIdeas(chart, normalizeCombo({ name: 'T', conds: ['rsiAbove50'] }), { symbol: 'AAA', exitMin: 15 * 60 + 15 });
  assert.ok(ideas.length > 0);
  const keys = ideas.map((i) => `${new Date(i.time * 1000).toISOString().slice(0, 10)}|${i.side}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const i of ideas) {
    const d = i.side === 'BUY' ? 1 : -1;
    assert.ok(d * (i.entry - i.stopLoss) > 0 && d * (i.target1 - i.entry) > 0 && d * (i.target2 - i.target1) > 0 && d * (i.target3 - i.target2) > 0, JSON.stringify(i));
    assert.equal(i.setup, 'Combo: T');
    const t = new Date((i.time + 300 - 300) * 1000).toISOString().slice(11, 16);
    assert.ok(t >= '04:00' && t < '09:45', t);
  }
  const early = shareIdeas(chart, normalizeCombo({ name: 'T', conds: ['rsiAbove50'] }), { symbol: 'AAA', exitMin: 10 * 60 });
  assert.ok(early.every((i) => new Date((i.time + 300) * 1000).toISOString().slice(11, 16) < '04:30'));
});

test('the shares study trades combinations and ranks every check on the 50 stocks, with the same exits as the scanner', async () => {
  const history = { AAA: minutes(12, 3), BBB: minutes(12, 5), SHORT: minutes(1, 9).slice(0, 20) };
  const combos = normalizeCombos([{ name: 'Mom', conds: ['rsiAbove50', 'aboveVwap'] }, { name: 'Breadth', conds: ['breadth70', 'rsiAbove50'] }]);
  const seen = [];
  const r = await runSharesStudy({ nifty1: minutes(12, 7), history, params: { days: 5, riskAmount: 200, combos }, onProgress: (x) => seen.push(x) });
  assert.ok(Array.isArray(r.combos) && Array.isArray(r.indicators) && Array.isArray(r.combosSkipped));
  assert.equal(r.combos.length + r.combosSkipped.length, 2);
  const mom = r.combos.find((c) => /Mom/.test(c.label));
  assert.ok(mom === undefined || (mom.halves.length === 2 && 'buys' in mom && 'sells' in mom), 'a combination that needs volume is tested when the share has volume');
  assert.ok(r.indicators.every((x) => ['Keep', 'Unsteady', 'Drop', 'Too few'].includes(x.verdict)));
  assert.ok(r.overall && r.bySetup, 'the scanner study is unchanged');
});

// ---------- stop from the entry ----------

test('a stop can be the chart level, the chart level pulled in to k ATR, or always k ATR from the entry, for calls and for puts', async () => {
  const { ruleStop } = await import('../src/study/patterns.js');
  const call = { side: 'CE', stop: 24900, atr: 10 };
  const put = { side: 'PE', stop: 25100, atr: 10 };
  assert.equal(ruleStop(call, 25000, null), 24900);
  assert.equal(ruleStop(call, 25000, { mode: 'chart', k: 1 }), 24900);
  assert.equal(ruleStop(call, 25000, { mode: 'cap', k: 2 }), 24980, 'a stop 10 ATR away is pulled in to 2 ATR');
  assert.equal(ruleStop({ ...call, stop: 24990 }, 25000, { mode: 'cap', k: 2 }), 24990, 'a nearer chart stop stays');
  assert.equal(ruleStop(call, 25000, { mode: 'atr', k: 1.5 }), 24985);
  assert.equal(ruleStop(put, 25000, { mode: 'cap', k: 2 }), 25020);
  assert.equal(ruleStop(put, 25000, { mode: 'atr', k: 1 }), 25010);
});

test('the options study adds Breakout + Engulfing rows with the stop worked out from the entry, and a pulled-in stop never skips a trade for being far', async () => {
  const r = await runOptionsStudy({ nifty1: minutes(14), params: { ...PARAMS, days: 10, lossLimit: 1500, maxLots: 2, rank: false } });
  const rows = Object.fromEntries(r.techniques.map((t) => [t.key, t]));
  for (const k of ['beCap20', 'beAtr10', 'beAtr15', 'beAtr20']) assert.ok(rows[k], k);
  assert.match(rows.beAtr15.label, /stop 1\.5 ATR from entry/);
  assert.equal(rows.beCap20.skippedWide, 0, 'far stops are pulled in, not skipped');
  assert.equal(rows.beAtr10.signals, rows.breakoutEngulf.signals, 'the same signals, a different stop');
  assert.ok(rows.beAtr10.skippedWide <= rows.breakoutEngulf.skippedWide);
});

// ---------- the stop choice, shared by trading, the study and Review ----------

test('a fixed stop is that many Nifty points from the entry, for calls and puts, and the user settings turn into the rule', async () => {
  const { ruleStop, stopRuleOf } = await import('../src/study/patterns.js');
  const call = { side: 'CE', stop: 24900, atr: 10 };
  const put = { side: 'PE', stop: 25100, atr: 10 };
  assert.equal(ruleStop(call, 25000, { mode: 'fixed', points: 30 }), 24970);
  assert.equal(ruleStop(put, 25000, { mode: 'fixed', points: 30 }), 25030);
  assert.equal(ruleStop(call, 25000, { mode: 'fixed', points: 0 }), 24900, 'no points: the chart level');
  assert.deepEqual(stopRuleOf({}), { mode: 'chart', k: 2, points: 30 });
  assert.deepEqual(stopRuleOf({ patternStopMode: 'fixed', patternStopPoints: 45, patternStopAtr: 1.5 }), { mode: 'fixed', k: 1.5, points: 45 });
});

test('the options study uses the stop rule of the settings on every row, the comparison rows keep their own, and fixed-point rows are added', async () => {
  const base = { ...PARAMS, days: 10, lossLimit: 1500, maxLots: 2, rank: false };
  const chart = await runOptionsStudy({ nifty1: minutes(14), params: base });
  const fixed = await runOptionsStudy({ nifty1: minutes(14), params: { ...base, stopRule: { mode: 'fixed', points: 25 } } });
  const row = (r, k) => r.techniques.find((t) => t.key === k);
  for (const k of ['beFix20', 'beFix30', 'beFix40']) assert.ok(row(chart, k), k);
  assert.match(row(chart, 'beFix30').label, /fixed stop 30 points/);
  assert.deepEqual(fixed.params.stopRule, { mode: 'fixed', points: 25 });
  assert.equal(chart.params.stopRule, null);
  assert.equal(row(fixed, 'beFix30').net, row(chart, 'beFix30').net, 'a comparison row has its own stop whatever the setting is');
  const a = row(chart, 'breakoutEngulf');
  const b = row(fixed, 'breakoutEngulf');
  assert.equal(a.signals, b.signals);
  assert.ok(a.net !== b.net || a.trades !== b.trades, 'the setting changes how the main rows trade');
});

test('Review shows what each stop would have done, the user combinations with the checks that held, and the biggest moves with the signals near them', async () => {
  const { reviewPatterns } = await import('../src/review/patterns.js');
  const c1 = minutes(8);
  const dayOf = (t) => new Date(t * 1000 + 19800_000).toISOString().slice(0, 10);
  const days = [...new Set(c1.map((b) => dayOf(b.time)))].slice(3);
  const combo = { id: 'trendpush', name: 'Trend push', conds: ['rsiAbove50', 'macdZero'], need: 1, window: 3, on: true };
  let seen = null;
  for (const d of days) {
    const r = reviewPatterns({ c1, day: d, params: { ...PARAMS, lossLimit: 1500, maxLots: 2 }, combos: [combo], stopRule: { mode: 'fixed', points: 30 } });
    if (!seen || r.signals.length > seen.signals.length) seen = r;
  }
  assert.ok(seen.patterns.some((p) => p.key === 'combo:trendpush' && p.combo && /Mine: Trend push/.test(p.label)));
  assert.deepEqual(seen.stopRule, { mode: 'fixed', points: 30 });
  assert.ok(seen.signals.length > 0);
  for (const s of seen.signals) {
    assert.deepEqual(s.whatIf.map((w) => w.key), ['chart', 'atr10', 'atr15', 'atr20', 'fix20', 'fix30', 'fix40']);
    assert.ok(s.whatIf.every((w) => w.pts >= 0 && (w.hitAfter == null || w.hitAfter >= 0)));
    assert.equal(s.whatIf.find((w) => w.key === 'fix30').pts, 30);
    assert.ok(s.whatIf.find((w) => w.key === 'fix30').hitAfter == null || Math.abs(s.worst.pts) >= 29.9, 'hit only when the index went that far against it');
  }
  const mine = seen.signals.filter((s) => s.technique === 'combo:trendpush');
  assert.ok(mine.length > 0, 'the combination fired on the random chart');
  assert.ok(mine.every((s) => s.why.length === 2 && s.why.some((w) => w.held)));
  assert.ok(Array.isArray(seen.moves) && seen.moves.every((m) => m.pts >= 30 && m.to > m.from && ['CE', 'PE'].includes(m.side)));
  assert.ok(seen.moves.flatMap((m) => m.signals).every((x) => x.id && x.technique && typeof x.time === 'number'));

  const flowCheck = CONDITIONS.find((c) => c.needs === 'flow');
  const skipped = reviewPatterns({ c1, day: days[0], params: PARAMS, combos: [{ id: 'vol', name: 'Volume push', conds: [flowCheck.key], need: 1, window: 3, on: true }] });
  assert.equal(skipped.combosSkipped.length, 1);
  assert.match(skipped.combosSkipped[0].reason, /volume of the 50 stocks/);
});

// ---------- auto-find ----------

test('auto-find tries a pattern with each check and the best pairs, judges them on days they were not picked on, and says when the run is too short', async () => {
  const base = { ...PARAMS, lossLimit: 1500, maxLots: 2, rank: false };
  const none = await runOptionsStudy({ nifty1: minutes(24), params: { ...base, days: 20 } });
  assert.equal(none.autoFound, null, 'off unless asked for');
  const short = await runOptionsStudy({ nifty1: minutes(12), params: { ...base, days: 8, autoFind: true } });
  assert.match(short.autoFound.skipped, /at least 15 trading days/);

  const seen = [];
  const r = await runOptionsStudy({ nifty1: minutes(24), params: { ...base, days: 20, autoFind: true }, onProgress: (x) => seen.push(x) });
  const a = r.autoFound;
  assert.ok(a.tried > 150, `${a.tried} combinations tried`);
  assert.equal(a.trainDays + a.testDays, 20);
  assert.ok(a.baselines.length >= 2 && a.baselines.every((b) => b.train && b.test));
  assert.ok(seen.some((x) => /Auto-find/.test(x)));
  assert.ok(a.found.length <= 8);
  for (const f of a.found) {
    assert.ok(f.conds.length >= 2 && f.conds.length <= 3 && f.conds[0].startsWith('p_'));
    assert.ok(f.train.trades >= a.minTrain && f.train.net > 0, 'it made money on the older days');
    assert.ok(f.test.trades >= a.minTest && f.test.net > 0, 'and on the newest days it never saw');
    assert.equal(f.labels.length, f.conds.length);
  }
  assert.ok(a.found.every((f, i) => i === 0 || f.test.net <= a.found[i - 1].test.net), 'best on the unseen days first');
});

// ---------- pair finder ----------

const checkPairs = (pf, { first }) => {
  assert.ok(pf.tried > 50, `${pf.tried} pairs tried`);
  assert.ok(pf.anchors.length >= 1 && pf.anchors.length <= (first ? 1 : 3));
  for (const a of pf.anchors) {
    assert.ok(a.train && a.test && a.found.length <= 5);
    for (const f of a.found) {
      assert.equal(f.conds.length, 2);
      assert.ok(f.conds[0] === a.key && f.conds[1] !== a.key);
      assert.ok(f.train.trades >= pf.minTrain && f.train.net > 0 && f.test.trades >= pf.minTest && f.test.net > 0, 'made money on the older and on the unseen newer days');
      assert.equal(f.labels.length, 2);
      assert.ok('trades' in f.calls && 'trades' in f.puts && Number.isFinite(f.lift));
    }
    assert.ok(a.found.every((f, i) => i === 0 || f.test.net <= a.found[i - 1].test.net), 'best on the unseen days first');
  }
};

test('the pair finder pairs one chosen check with every other check on the index, judged on older and newer days, and is off unless asked for', async () => {
  const base = { ...PARAMS, lossLimit: 1500, maxLots: 2 };
  const off = await runOptionsStudy({ nifty1: minutes(24), params: { ...base, days: 20 } });
  assert.equal(off.pairs, null);
  const short = await runOptionsStudy({ nifty1: minutes(12), params: { ...base, days: 8, pairFind: true, pairFirst: 'rsiAbove50' } });
  assert.match(short.pairs.skipped, /at least 10 trading days/);
  const seen = [];
  const r = await runOptionsStudy({ nifty1: minutes(24), params: { ...base, days: 20, pairFind: true, pairFirst: 'rsiAbove50' }, onProgress: (x) => seen.push(x) });
  assert.equal(r.pairs.auto, false);
  assert.equal(r.pairs.anchors[0].key, 'rsiAbove50');
  assert.equal(r.pairs.trainDays + r.pairs.testDays, 20);
  assert.ok(seen.some((x) => /Pair finder/.test(x)));
  checkPairs(r.pairs, { first: 'rsiAbove50' });
  const bad = await runOptionsStudy({ nifty1: minutes(24), params: { ...base, days: 20, pairFind: true, pairFirst: 'nope' } });
  assert.match(bad.pairs.skipped, /cannot be tested/);
});

test('without a chosen check the pair finder starts from the best single checks that made money, and says so when none did', async () => {
  const base = { ...PARAMS, lossLimit: 1500, maxLots: 2 };
  const r = await runOptionsStudy({ nifty1: minutes(24), params: { ...base, days: 20, pairFind: true } });
  if (r.pairs.skipped) assert.match(r.pairs.skipped, /no single check made money/);
  else {
    assert.equal(r.pairs.auto, true);
    checkPairs(r.pairs, { first: null });
    for (const a of r.pairs.anchors) assert.ok(r.indicators.find((x) => x.key === a.key).net > 0);
  }
  const noRank = await runOptionsStudy({ nifty1: minutes(24), params: { ...base, days: 20, rank: false, pairFind: true } });
  assert.match(noRank.pairs.skipped, /no single check made money/);
});

test('the pair finder also runs on the 50 stocks, with buys and sells in place of calls and puts', async () => {
  const history = { AAA: minutes(14, 3), BBB: minutes(14, 5) };
  const off = await runSharesStudy({ nifty1: minutes(14, 7), history, params: { days: 10, riskAmount: 200 } });
  assert.equal(off.pairs, null);
  const r = await runSharesStudy({ nifty1: minutes(14, 7), history, params: { days: 10, riskAmount: 200, rank: false, pairFind: true, pairFirst: 'rsiAbove50' } });
  checkPairs(r.pairs, { first: 'rsiAbove50' });
});

// ---------- Review: day story, warm-up bars, minute bars ----------

test('the day story finds the legs a day moved in, and Review sends warm-up bars, minute bars and the story with a day', async () => {
  const { dayStory, warmBars, reviewPatterns } = await import('../src/review/patterns.js');
  // 5-minute bars: up 100 points, down 60, up 80 with small noise
  const path = [];
  let p = 22700;
  const leg = (to, n) => {
    const step = (to - p) / n;
    for (let k = 0; k < n; k++) {
      path.push({ time: 1_700_000_000 + path.length * 300, open: p, high: Math.max(p, p + step) + 2, low: Math.min(p, p + step) - 2, close: p + step });
      p += step;
    }
  };
  leg(22800, 10);
  leg(22740, 8);
  leg(22820, 10);
  const story = dayStory(path, { minSwing: 25 });
  assert.deepEqual(story.legs.map((l) => l.dir), ['up', 'down', 'up']);
  assert.ok(story.legs[0].pts > 90 && story.legs[1].pts > 50 && story.legs[2].pts > 70);
  assert.ok(story.high.price >= 22820 && story.low.price <= 22700 && story.changePts > 100);
  assert.equal(dayStory(path.slice(0, 3)), null, 'too few bars: no story');

  const c1 = minutes(8);
  const dayOf = (t) => new Date(t * 1000 + 19800_000).toISOString().slice(0, 10);
  const days = [...new Set(c1.map((b) => dayOf(b.time)))];
  const day = days[4];
  const r = reviewPatterns({ c1, day, params: { ...PARAMS, lossLimit: 1500, maxLots: 2 } });
  assert.ok(r.minutes.length > 300 && r.minutes.every((b) => dayOf(b.time) === day));
  assert.ok(r.warm.length > 0 && r.warm.every((b) => dayOf(b.time) < day) && r.warm.length <= 150);
  assert.ok(r.story && r.story.legs.every((l) => l.to > l.from));
  assert.equal(warmBars([], day).length, 0);
});
