import test from 'node:test';
import assert from 'node:assert/strict';
import { tuneShares, shareMoves, shareSettingsOf, sharePatch, shareTrades, shareFacts } from '../src/learner/shareTune.js';

const keys = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));
const OPTS = { riskAmount: 300, slippagePct: 0.05 };

/** A replayed idea at `hhmm` IST on `day`: a buy at 1,000 with a 0.8% stop, won to 1,012 or stopped at 992. */
function idea(day, hhmm, win, setup = 'Opening range breakout') {
  const [h, m] = hhmm.split(':').map(Number);
  const openedAt = new Date(Date.parse(`${day}T00:00:00Z`) + ((h * 60 + m) - 330) * 60000).toISOString();
  return { setup, side: 'BUY', score: 85, openedAt, entry: 1000, stopLoss: 992, target1: 1012, status: win ? 'TARGET_HIT' : 'STOPPED', exit: win ? 'LOCK' : 'STOP', exitPrice: win ? 1012 : 992, exitTime: Date.parse(openedAt) / 1000 + 1800, sizedQty: 37, facts: { stopPct: 0.8 } };
}

/** Mornings win, afternoons lose: the learner should stop new share trades before the afternoon. */
const ideasFor = (days, { lateLoses = true } = {}) => days.flatMap((d) => [idea(d, '09:40', true), idea(d, '10:10', true), idea(d, '13:30', !lateLoses), idea(d, '14:00', false)]);

test('share settings are read from what is saved and written back to the same fields', () => {
  const s = shareSettingsOf({ entryTo: 690, skipSetups: ['Gap and go'], shareRules: { minRelVol: 1.2 } });
  assert.equal(s.entryTo, 690);
  assert.equal(s.rules.minRelVol, 1.2);
  assert.equal(s.rules.minStopPct, 0.5, 'missing rules come from the defaults');
  assert.deepEqual(sharePatch(s), { entryFrom: 555, entryTo: 690, skipSetups: ['Gap and go'], shareRules: s.rules });
});

test('the share changes cover entry hours, setups, entry rules and the exit, never the score or stop-after-losses', () => {
  const moves = shareMoves(shareSettingsOf({}), ['Opening range breakout', 'Gap and go']);
  const groups = new Set(moves.map((m) => m.group));
  for (const g of ['Entry hours', 'Setups', 'Entry rules', 'Exit']) assert.ok(groups.has(g), g);
  assert.ok(moves.some((m) => m.label === 'No new share trade from 11:00'));
  assert.ok(moves.some((m) => m.label === 'Switch off Gap and go'));
  assert.ok(!moves.some((m) => /score|losses/i.test(m.label)));
});

test('a change that holds on the hidden days passes; trades by setup and hour are listed', async () => {
  const ideas = ideasFor(keys(16));
  const r = await tuneShares({ ideas, current: shareSettingsOf({ entryTo: 915 }), opts: OPTS });
  assert.equal(r.verdict, 'passed', r.text);
  assert.ok(r.proposal.entryTo <= 750, `stops before the afternoon: ${r.proposal.entryTo}`);
  assert.ok(r.hidden.new.net > r.hidden.old.net);
  assert.ok(shareFacts(shareTrades(ideas, shareSettingsOf({}), OPTS)).byHour.length >= 3);
});

test('a change that only fits the learning days fails, and too few days learn nothing', async () => {
  const days = keys(16);
  const hidden = new Set(days.slice(-4));
  const ideas = days.flatMap((d) => (hidden.has(d) ? [idea(d, '09:40', false), idea(d, '10:10', false), idea(d, '13:30', true), idea(d, '14:00', true)] : ideasFor([d])));
  const r = await tuneShares({ ideas, current: shareSettingsOf({}), opts: OPTS });
  assert.equal(r.verdict, 'failed');
  const short = await tuneShares({ ideas: ideasFor(keys(5)), current: shareSettingsOf({}), opts: OPTS });
  assert.equal(short.verdict, 'short');
});
