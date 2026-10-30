import { describe, expect, it } from 'vitest';
import { pairsText } from './pairs.js';

const p = (trades, net) => ({ trades, net, winRate: 55 });
const pf = {
  tried: 90,
  trainDays: 13,
  testDays: 7,
  anchors: [{ key: 'rsiAbove50', label: 'RSI above 50', ...p(40, 1000), train: p(25, 800), test: p(15, 200), found: [{ conds: ['rsiAbove50', 'aboveVwap'], labels: ['RSI above 50', 'Price above VWAP'], ...p(30, 2500), lift: 1500, calls: { trades: 20, net: 1800 }, puts: { trades: 10, net: 700 }, train: p(20, 1700), test: p(10, 800) }] }],
};

describe('pairsText', () => {
  it('lists each starting check with its partners', () => {
    const t = pairsText(pf);
    expect(t).toContain('90 pairs tried');
    expect(t).toContain('Starting from RSI above 50');
    expect(t).toContain('+ Price above VWAP: 30 trades');
    expect(t).toContain('Calls');
  });
  it('says when no partner worked, or the run was skipped, and is empty without a result', () => {
    expect(pairsText({ ...pf, anchors: [{ ...pf.anchors[0], found: [] }] })).toContain('No partner made money');
    expect(pairsText({ skipped: 'needs at least 10 trading days, this run had 5' })).toContain('needs at least 10');
    expect(pairsText(null, 'Buys', 'Sells')).toBe('');
  });
  it('uses the words for the side it is given', () => {
    expect(pairsText(pf, 'Buys', 'Sells')).toContain('Buys');
  });
});

describe('add-on rows', () => {
  it('names the added check and says how many trades it skips', () => {
    const f = { ...pf.anchors[0].found[0], added: 'Price above VWAP', skipped: 4 };
    const t = pairsText({ ...pf, addOn: true, anchors: [{ ...pf.anchors[0], found: [f] }] });
    expect(t).toContain('+ Price above VWAP');
  });
});
