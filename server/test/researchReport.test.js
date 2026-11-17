import test from 'node:test';
import assert from 'node:assert/strict';
import { researchReport } from '../scripts/researchReport.js';

const part = (trades, net) => ({ trades, net, winRate: 60 });
const row = (labels, net) => ({ conds: labels, labels, trades: 20, winRate: 65, net, calls: { trades: 12, net: net / 2 }, puts: { trades: 8, net: net / 2 }, train: part(14, net * 0.6), test: part(6, net * 0.4) });

test('the night report lists indicators, new combinations, testers, shares and Learn, and says what failed', () => {
  const out = {
    generatedAt: '2026-11-17T18:00:00Z',
    errors: { moved: 'No real option prices are saved yet' },
    parts: {
      options: {
        period: { from: '2026-10-06', to: '2026-11-17', days: 30 },
        pricing: { mode: 'real' },
        indicators: [{ label: '20-bar high', trades: 40, winRate: 60, net: 52000, calls: { net: 50000 }, puts: { net: 2000 }, halves: [{ net: 30000 }, { net: 22000 }], verdict: 'keep' }, { label: 'MACD | cross', trades: 30, winRate: 40, net: -9000, halves: null, verdict: 'drop' }],
        techniques: [{ key: 'combo:a', combo: true, label: 'My combination: A', trades: 10, winRate: 50, net: 1000, halves: [{ net: 400 }, { net: 600 }] }, { key: 'breakout', label: 'Breakout', net: 5 }],
        autoFound: { found: [row(['Breakout', 'Above VWAP'], 8000)] },
        research: { bestExit: { label: 'Start +₹2,000', net: 9000 }, bestStop: null },
      },
      optionsFind: { comboFound: { tried: 300, found: [row(['A', 'B', 'C'], 12000)] }, pairs: { tried: 500, anchors: [{ label: 'Aroon up', found: [{ ...row(['Aroon up', 'RSI'], 7000), added: ['RSI'] }] }] }, winFound: { skipped: 'no single check had enough trades' } },
      ladder: { best: { text: 'Start +₹2,500 keeps more on the newest days.' } },
      shares: { combos: [{ label: 'ORB', trades: 49, winRate: 55, totalNet: 9901 }], indicators: [] },
      learn_combos: { list: [{ name: 'Breakout + Keltner', verdict: 'passed', text: 'Better on the hidden days.', changes: [{ label: 'own loss cut: sell at -₹1,000' }] }] },
      learn_setup: { verdict: 'same', text: 'No change helped.', changes: [] },
      learn_shares: { verdict: 'failed', text: 'Failed on the newest days.', changes: [{ label: 'No new share trade from 11:00', from: '11:30', to: '11:00' }] },
    },
  };
  const md = researchReport(out, { email: 'a@b.c', took: '42 min' });
  for (const want of ['20-bar high', '₹52,000', 'MACD / cross', 'My combination: A', 'Breakout + Above VWAP', 'A + B + C', 'Aroon up + RSI', 'no single check', 'Start +₹2,500', 'ORB', 'own loss cut', 'No new share trade from 11:00', 'moved: No real option', '42 min']) assert.ok(md.includes(want), `report has ${want}`);
  assert.ok(!md.includes('undefined') && !md.includes('NaN'), md);
});

test('an empty night still makes a report', () => {
  const md = researchReport({ generatedAt: '2026-11-17T18:00:00Z', errors: {}, parts: {} }, { email: 'a@b.c', took: '1 min' });
  assert.match(md, /Night research/);
});
