import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExamples, AHEAD_BARS } from '../src/lab/examples.js';
import { CONDITIONS } from '../src/combos/conditions.js';

// Six market days of Nifty 1-minute candles: a slow wave, so trend checks turn true and false a few times a day.
function nifty() {
  const out = [];
  const day0 = Date.UTC(2026, 9, 26, 3, 45) / 1000; // Monday 09:15 IST
  let p = 24000;
  for (let d = 0; d < 6; d++) {
    for (let m = 0; m < 375; m++) {
      const o = p;
      p = o + 6 * Math.sin((d * 375 + m) / 40) + (m % 7 === 0 ? -2 : 1);
      out.push({ time: day0 + d * 86400 + m * 60, open: o, high: Math.max(o, p) + 2, low: Math.min(o, p) - 2, close: p, volume: 0 });
    }
  }
  return out;
}

test('a check is shown with every entry it would have taken on the chosen days, and where the index went next', () => {
  const key = CONDITIONS.find((c) => !c.needs && c.kind === 'event')?.key ?? CONDITIONS.find((c) => !c.needs).key;
  const r = checkExamples({ nifty1: nifty(), keys: [key], days: 3 });
  assert.ok(!r.error, r.error);
  assert.equal(r.days, 3);
  assert.equal(r.bars.length, 3 * 75);
  assert.ok(r.entries.length > 0, 'a wave makes it fire');
  for (const e of r.entries) {
    assert.ok(r.bars.some((b) => b.time + 300 === e.time), 'entries sit on the bars shown');
    assert.ok(['CE', 'PE'].includes(e.side));
    if (e.after != null) assert.ok(e.best >= e.after && e.worst <= e.after);
  }
  assert.equal(r.summary.entries, r.entries.length);
  assert.equal(r.summary.calls + r.summary.puts, r.entries.length);
  assert.equal(AHEAD_BARS, 6);
});

test('a combination of checks, an unknown key, and a check that needs the 50 stocks', () => {
  const plain = CONDITIONS.filter((c) => !c.needs).slice(0, 2).map((c) => c.key);
  const both = checkExamples({ nifty1: nifty(), keys: plain, need: 2, window: 3, days: 5 });
  assert.ok(!both.error);
  assert.ok(both.name.includes(' + '));
  assert.deepEqual(checkExamples({ nifty1: nifty(), keys: ['nope'] }), { error: 'Unknown check' });
  const needy = CONDITIONS.find((c) => c.needs === 'breadth');
  if (needy) assert.match(checkExamples({ nifty1: nifty(), keys: [needy.key] }).error, /50-stock/);
});
