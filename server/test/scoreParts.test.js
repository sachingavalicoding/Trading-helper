import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStudy, suggestWeights, partTable, statsOf, scoreWith, MIN_SIDE } from '../src/study/scoreParts.js';
import { WEIGHTS } from '../src/scanner/evaluate.js';

// Ideas where "keltner" agreeing goes with a win and everything else is random noise: the study must find keltner and nothing else.
function fakeIdeas(n = 120) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let k = 0; k < n; k++) {
    const kel = k % 2 === 0;
    const parts = Object.fromEntries(Object.keys(WEIGHTS).map((id) => [id, rnd() > 0.5 ? 1 : 0]));
    parts.keltner = kel ? 1 : 0;
    parts.setup = 1;
    const win = kel ? rnd() < 0.75 : rnd() < 0.3;
    const day = String(1 + Math.floor((k / n) * 9)).padStart(2, '0');
    out.push({ symbol: 'X', setup: 'Opening range breakout', side: 'BUY', entry: 100, stopLoss: 99, status: win ? 'TARGET_HIT' : 'STOPPED', exitPrice: win ? 102 : 99, openedAt: `2026-10-${day}T05:00:00.000Z`, score: Math.round(scoreWith(parts, WEIGHTS)), parts });
  }
  return out;
}

test('the score study finds the part that really separates winners, and its weights add up to 100', () => {
  const r = scoreStudy(fakeIdeas(), { riskAmount: 1000, slippagePct: 0 });
  assert.equal(r.ideas, 120);
  const top = r.parts[0];
  assert.equal(top.id, 'keltner');
  assert.equal(top.verdict, 'helps');
  assert.ok(top.on.winRate > top.off.winRate);
  assert.ok(r.suggested);
  assert.equal(Object.values(r.suggested).reduce((a, b) => a + b, 0), 100);
  assert.ok(r.suggested.keltner >= Math.max(...Object.entries(r.suggested).filter(([id]) => !['keltner', 'setup', 'book'].includes(id)).map(([, w]) => w)), 'keltner gets the most');
  assert.ok(r.check && r.check.ideas >= 20, 'newer days check the weights fit on older ones');
  assert.ok(r.check.suggested.avgNet >= r.check.all.avgNet);
  assert.equal(r.bands.now.length, 6);
});

test('too few ideas on one side is reported, not guessed', () => {
  const few = fakeIdeas(MIN_SIDE);
  const rows = partTable(few.map((i) => ({ ...i, net: i.status === 'TARGET_HIT' ? 1 : -1 })));
  assert.ok(rows.every((r) => r.verdict === 'too few'));
  assert.equal(suggestWeights(few.map((i) => ({ ...i, net: 1 }))), null);
  assert.deepEqual(statsOf([]), { trades: 0, winRate: null, avgNet: null, totalNet: 0 });
  assert.equal(scoreStudy([], {}).ideas, 0);
});
