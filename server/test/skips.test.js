import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareSkips } from '../src/replay/skips.js';

// 12:05 IST on 11 Nov 2026 = 06:35 UTC
const at = Date.UTC(2026, 10, 11, 6, 35) / 1000;

test('a losing share trade lists the rules that would have skipped it and the late-entry signs', () => {
  const log = {
    side: 'BUY', score: 76, entry: 1000, stopLoss: 997, fillPrice: 1002,
    card: { facts: { niftyTrend: 0, relStrength: 0.1, relVol: 0.9, stopPct: 0.3 }, checks: [{ key: 'mfi', label: 'Money flow', points: 2, max: 2, text: '' }, { key: 'rsi', label: 'RSI', points: 0, max: 5, text: '' }] },
  };
  const s = shareSkips({ log, settings: { minScore: 70, entryTo: 915, shareRules: { minRelVol: 1.2 } }, lossesBefore: 2, net: -350, entryTime: at });
  const by = Object.fromEntries(s.rules.map((r) => [r.key, r]));
  for (const k of ['score', 'time', 'stop', 'nifty', 'strength', 'volume', 'chase', 'losses']) assert.equal(by[k].skip, true, k);
  assert.equal(by.volume.on, true);
  assert.equal(by.score.on, false);
  assert.match(s.text, /8 rules would have skipped this loss\. 6 of them are off/);
  assert.deepEqual(s.late.map((c) => c.key), ['mfi']);
  assert.equal(s.lost, true);
});

test('a trade that passed every rule says so, and options get nothing', () => {
  const log = { side: 'SELL', score: 85, entry: 1000, stopLoss: 1010, fillPrice: 999, card: { facts: { niftyTrend: -1, relStrength: -0.6, relVol: 1.5, stopPct: 1 } } };
  const s = shareSkips({ log, settings: {}, lossesBefore: 0, net: -100, entryTime: Date.UTC(2026, 10, 11, 4, 0) / 1000 });
  assert.ok(s.rules.every((r) => r.skip === false), JSON.stringify(s.rules));
  assert.match(s.text, /passed every one, and still lost/);
  assert.equal(shareSkips({ log: { ...log, segment: 'OPT' } }), null);
});
