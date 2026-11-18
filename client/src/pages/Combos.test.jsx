import { describe, expect, it } from 'vitest';
import { botLine } from './Combos.jsx';

describe('Combos page', () => {
  it('says in one line what each bot buys on', () => {
    const options = { settings: { enabled: true, scoreEntries: false, patternEntries: true, patterns: ['breakout'], comboEntries: true, combos: [{ on: true }, { on: false }] } };
    expect(botLine('options', options)).toBe('Options bot on · buys on 1 chart pattern, 1 combination');
    const shares = { settings: { enabled: false, skipSetups: ['B'], trendScore: false, combos: [] }, setupChoices: ['A', 'B', 'Trend score'] };
    expect(botLine('shares', shares)).toBe('Shares bot off · 0 combinations and 1 setup on');
  });
});
