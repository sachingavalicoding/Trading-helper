import { describe, expect, it } from 'vitest';
import { pairsText, skipsText, winnerOf, winnerText } from './pairs.js';

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

describe('finder results', () => {
  const f = (over) => ({ conds: ['a', 'b'], labels: ['A', 'B'], added: ['B'], depth: 1, trades: 40, winRate: 80, net: 8000, lift: 3000, calls: { trades: 20, net: 4000 }, puts: { trades: 20, net: 4000 }, train: { trades: 28, winRate: 78, net: 5000 }, test: { trades: 12, winRate: 83, net: 3000 }, skipped: 20, skips: { trades: 20, losers: 14, losersNet: -6000, winners: 6, winnersNet: 2000 }, ...over });
  const pf2 = { tried: 30, trainDays: 20, testDays: 10, goal: 'profit', anchors: [{ key: 'combo:x', label: 'Mine', trades: 60, winRate: 62, net: 5000, train: { trades: 40, winRate: 60, net: 3000 }, test: { trades: 20, winRate: 65, net: 2000 }, found: [f({}), f({ added: ['C'], winRate: 90, net: 6000, test: { trades: 9, winRate: 90, net: 1000 } })] }] };
  it('says which entries a result skips', () => {
    expect(skipsText(f({}))).toBe('skips 20 entries: 14 losers (-₹6,000.00), 6 winners (+₹2,000.00)');
    expect(skipsText(f({ skips: null, skipped: 0 }))).toBe('');
  });
  it('names the best result by profit or by win rate', () => {
    expect(winnerOf(pf2).f.added).toEqual(['B']);
    expect(winnerOf({ ...pf2, goal: 'winrate' }).f.added).toEqual(['C']);
    expect(winnerText(pf2)).toContain('80% win (Mine alone 62%)');
    expect(pairsText(pf2)).toContain('win rate 62% to 80%');
  });
});
