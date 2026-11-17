import { describe, expect, it } from 'vitest';
import { loadErrorText, runningText, applyState, compareRows, diffWord, groupChanges, splitLine, verdictBox, windowTitle } from './learn.js';

const stat = (o = {}) => ({ days: 5, trades: 8, wins: 5, winRate: 63, net: 1000, avgDay: 200, goodDays: 3, badDays: 2, worstDay: -400, bestDay: 900, avgWin: 500, avgLoss: 300, payoff: 1.67, downside: 200, score: 120, ...o });

describe('Lab > Learn words', () => {
  it('a pass opens Apply, a fail asks first, and nothing else offers it', () => {
    expect(verdictBox({ verdict: 'passed' })).toMatchObject({ tone: 'up', title: 'Passed', apply: 'open' });
    expect(verdictBox({ verdict: 'failed' })).toMatchObject({ tone: 'down', title: 'Failed', apply: 'confirm' });
    expect(applyState({ verdict: 'passed' }).action).toBe('apply');
    expect(applyState({ verdict: 'failed' }).action).toBe('confirm');
    expect(applyState({ verdict: 'same' }).action).toBe(null);
    expect(applyState({ verdict: 'short' }).action).toBe(null);
    expect(applyState(null).action).toBe(null);
  });

  it('an applied, undone or out-of-date result cannot be applied again', () => {
    expect(applyState({ verdict: 'passed', applied: { at: 'x' } })).toMatchObject({ action: null });
    expect(applyState({ verdict: 'passed', applied: { at: 'x' }, undone: { at: 'y' } }).why).toMatch(/Undone/);
    expect(applyState({ verdict: 'failed', stale: true }).why).toMatch(/changed/);
  });

  it('compares old and new on profit, steadiness, bad days, worst day and win/loss ratio', () => {
    const rows = compareRows({ old: stat(), new: stat({ net: 1500, score: 200, badDays: 1, worstDay: -200, payoff: 2 }) });
    expect(rows.map((r) => r.key)).toEqual(['net', 'score', 'badDays', 'worstDay', 'payoff', 'winRate']);
    expect(rows.filter((r) => r.better).map((r) => r.key)).toEqual(['net', 'score', 'badDays', 'worstDay', 'payoff']);
    expect(rows[0].new).toBe('₹1,500');
    expect(compareRows(null)).toEqual([]);
  });

  it('names the windows by how many of their days were hidden', () => {
    expect(windowTitle({ days: 5, hidden: 5 })).toBe('Last 5 days (all hidden)');
    expect(windowTitle({ days: 10, hidden: 5 })).toBe('Last 10 days (5 hidden, 5 learned on)');
    expect(windowTitle({ days: 15, hidden: 0 })).toBe('Last 15 days (all learned on)');
    expect(diffWord(1500, 1000)).toBe('+₹500');
    expect(diffWord(-100, 200)).toBe('-₹300');
    expect(diffWord(5, 5)).toBe('same');
  });

  it('groups changes in a fixed order and says how the days were split', () => {
    const g = groupChanges([{ group: 'Stop loss', label: 'a' }, { group: 'Combinations', label: 'b' }, { group: 'Stop loss', label: 'c' }]);
    expect(g.map((x) => x.group)).toEqual(['Combinations', 'Stop loss']);
    expect(g[1].list).toHaveLength(2);
    expect(splitLine({ split: { learnDays: 15, hiddenDays: 5, from: '2026-10-01', to: '2026-10-30', hiddenFrom: '2026-10-24' }, tried: 300, pricing: 'real' })).toMatch(/Learned on 15 days.*newest 5 days.*300 settings tried, real saved option prices/);
  });

  it('says why the card could not load, and how long a run has gone', () => {
    expect(loadErrorText({ status: 404 })).toMatch(/old code.*start\.sh/);
    expect(loadErrorText({ status: 0, message: 'Cannot reach the server' })).toMatch(/reach the app server/);
    expect(loadErrorText({ status: 500, message: 'boom' })).toBe('Could not load Learn: boom');
    expect(runningText({ step: 'Round 1: trying change 11 of 200', seconds: 75 })).toMatch(/^Round 1: trying change 11 of 200 · 1 min 15 s so far/);
    expect(runningText({ seconds: 9 })).toMatch(/^Starting · 9 s so far/);
  });
});
