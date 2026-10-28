import { describe, it, expect } from 'vitest';
import { blankCombo, toggleCheck, needOf, ruleText, toPayload, fromSaved, pickList, verdictMap, needsText, indicatorsText, MAX_CHECKS } from './combos.js';

const catalog = {
  groups: ['Trend', 'Momentum', 'Volume and VWAP'],
  conditions: [
    { key: 'a', label: 'EMA stack', text: 'lined up', group: 'Trend', kind: 'state', needs: null },
    { key: 'b', label: 'RSI above 50', text: 'buyers lead', group: 'Momentum', kind: 'state', needs: null },
    { key: 'c', label: 'Price above VWAP', text: 'day average', group: 'Volume and VWAP', kind: 'state', needs: 'flow' },
    { key: 'd', label: 'News agrees', text: 'headline', group: 'Trend', kind: 'state', needs: 'news' },
  ],
};

describe('combination editor helpers', () => {
  it('adds and removes checks, up to the most allowed', () => {
    let c = blankCombo();
    c = toggleCheck(c, 'a');
    c = toggleCheck(c, 'b');
    expect(c.conds).toEqual(['a', 'b']);
    expect(toggleCheck(c, 'a').conds).toEqual(['b']);
    let full = blankCombo();
    for (let i = 0; i < MAX_CHECKS + 3; i++) full = toggleCheck(full, `k${i}`);
    expect(full.conds).toHaveLength(MAX_CHECKS);
  });
  it('says the rule in words and keeps a partial rule inside the count', () => {
    let c = { ...blankCombo(), conds: ['a', 'b', 'c'] };
    expect(ruleText(c)).toBe('All 3 must hold together');
    c = { ...c, need: 2 };
    expect(needOf(c)).toBe(2);
    expect(ruleText(c)).toBe('Any 2 of 3 must hold together');
    expect(toggleCheck(c, 'c').need).toBe(2);
    expect(toggleCheck({ ...c, conds: ['a', 'b'], need: 2 }, 'c').need).toBe(0); // it was "all", so it stays "all"
    expect(ruleText({ ...blankCombo(), conds: ['a'] })).toBe('The check must hold');
    expect(ruleText(blankCombo())).toMatch(/No checks/);
  });
  it('sends a name, a real count and the window, and reloads a saved one', () => {
    const p = toPayload({ ...blankCombo(), id: 'x', name: '  ', conds: ['a', 'b'] }, 2);
    expect(p).toEqual({ id: 'x', name: 'Combination 3', conds: ['a', 'b'], need: 2, window: 3, on: true });
    expect(fromSaved({ id: 'x', name: 'n', conds: ['a', 'b'], need: 2, window: 3, on: true }).need).toBe(0);
    expect(fromSaved({ id: 'x', name: 'n', conds: ['a', 'b', 'c'], need: 2, window: 3, on: true }).need).toBe(2);
  });
});

describe('the pick list', () => {
  it('groups the checks and hides the ones a study dropped, until searched for', () => {
    const verdicts = { a: 'Keep', b: 'Drop' };
    const list = pickList(catalog, { verdicts });
    expect(list.groups.map((g) => g.group)).toEqual(['Trend', 'Volume and VWAP']);
    expect(list.dropped).toBe(1);
    expect(pickList(catalog, { verdicts, hideDropped: false }).groups.map((g) => g.group)).toEqual(['Trend', 'Momentum', 'Volume and VWAP']);
    expect(pickList(catalog, { verdicts, query: 'rsi' }).groups[0].items[0].key).toBe('b');
  });
  it('leaves out what the bot cannot use', () => {
    const list = pickList(catalog, { usable: (c) => c.needs !== 'news' });
    expect(list.groups.flatMap((g) => g.items.map((i) => i.key))).toEqual(['a', 'b', 'c']);
  });
  it('maps verdicts and names the data a check needs', () => {
    expect(verdictMap([{ key: 'a', verdict: 'Keep' }])).toEqual({ a: 'Keep' });
    expect(verdictMap(null)).toEqual({});
    expect(needsText(catalog.conditions[2])).toBe('Needs volume');
    expect(needsText(catalog.conditions[0])).toBe(null);
  });
  it('writes the ranking as text', () => {
    const t = indicatorsText([{ label: 'RSI above 50', group: 'Momentum', verdict: 'Keep', trades: 30, winRate: 55, net: 1200, halves: [500, 700] }]);
    expect(t).toMatch(/RSI above 50 \[Momentum\]: Keep, 30 trades, 55% win/);
    expect(indicatorsText([])).toBe('');
  });
});
