import { describe, expect, it } from 'vitest';
import { alreadySaved, autoFindText, foundName, withFound } from './autoFind.js';

const f = { conds: ['p_breakout', 'ema21_rising'], labels: ['Breakout of the last hour (5m)', 'EMA 21 rising'], trades: 12, winRate: 70, net: 4000, calls: { net: 4000, trades: 12 }, puts: { net: 0, trades: 0 }, train: { trades: 8, net: 2500, winRate: 75 }, test: { trades: 4, net: 1500, winRate: 50 } };
const af = { tried: 40, trainEnd: '2026-10-10', trainDays: 20, testDays: 10, minTrain: 10, minTest: 5, baselines: [{ label: 'Breakout', conds: ['p_breakout'], train: { trades: 10, net: 100, winRate: 60 }, test: { trades: 5, net: -50, winRate: 40 } }], found: [f] };

describe('foundName', () => {
  it('joins the checks and drops the bracketed detail', () => {
    expect(foundName(f)).toBe('Breakout of the last hour + EMA 21 rising');
  });
});

describe('withFound', () => {
  it('adds the combination switched off and keeps the saved ones', () => {
    const saved = [{ id: 'a', name: 'Mine', conds: ['x'], need: 1, window: 3, on: true }];
    const next = withFound(saved, f);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: 'a', on: true });
    expect(next[1]).toMatchObject({ conds: f.conds, need: 2, on: false });
  });
  it('works with nothing saved', () => {
    expect(withFound(undefined, f)).toHaveLength(1);
  });
});

describe('alreadySaved', () => {
  it('matches the same checks in any order', () => {
    expect(alreadySaved([{ conds: ['ema21_rising', 'p_breakout'] }], f)).toBe(true);
    expect(alreadySaved([{ conds: ['p_breakout'] }], f)).toBe(false);
  });
});

describe('autoFindText', () => {
  it('lists the starting points and the found combinations', () => {
    const t = autoFindText(af);
    expect(t).toContain('40 combinations tried');
    expect(t).toContain('Starting point Breakout');
    expect(t).toContain('Breakout of the last hour (5m) + EMA 21 rising: 12 trades');
  });
  it('says so when nothing was found, or the run was skipped', () => {
    expect(autoFindText({ ...af, found: [] })).toContain('Nothing made money');
    expect(autoFindText({ skipped: 'needs at least 15 trading days, this run had 9' })).toContain('needs at least 15');
    expect(autoFindText(null)).toBe('');
  });
});
