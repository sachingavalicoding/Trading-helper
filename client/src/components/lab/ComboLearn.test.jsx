import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComboLearn } from './ComboLearn.jsx';

const stat = (o = {}) => ({ days: 5, trades: 6, wins: 4, winRate: 67, net: 1000, avgDay: 200, goodDays: 3, badDays: 2, worstDay: -400, bestDay: 900, avgWin: 500, avgLoss: 300, payoff: 1.67, downside: 200, score: 120, ...o });
const view = {
  status: { state: 'idle' },
  combos: {
    at: '2026-11-17T12:00:00Z',
    daysAsked: 30,
    pricing: 'real',
    list: [
      { id: 'a', name: 'Breakout + Keltner', wasOn: true, verdict: 'passed', streak: 2, text: 'Passed: also better on the 7 hidden days.', changes: [{ group: 'Loss cut', label: 'own loss cut: sell at -₹1,000', from: 'no own loss cut', to: 'sell at -₹1,000' }], hidden: { old: stat({ net: -500 }), new: stat({ net: 900 }) }, all: { old: stat(), new: stat() }, notes: ['Every trade that went -₹1,000 or lower ended as a loss (3 trades): a cut near there costs no winner.'] },
      { id: 'b', name: 'Aroon + Supertrend', wasOn: true, verdict: 'failed', text: 'Failed on the 7 hidden days: lost money.', changes: [{ group: 'Side', label: 'calls only', from: 'calls and puts', to: 'calls only' }], hidden: { old: stat(), new: stat({ net: -900 }) } },
      { id: 'c', name: 'Quiet one', wasOn: false, verdict: 'few', text: 'Only 2 trades.', changes: [] },
    ],
  },
};

describe('Learn > Each combination', () => {
  it('shows passed results with Apply, asks before applying a failed one, and folds the rest away', () => {
    const act = vi.fn();
    render(<ComboLearn view={view} days="30" busy={false} running={false} act={act} />);
    expect(screen.getByText('Passed (2 runs in a row)')).toBeTruthy();
    expect(screen.getByText(/ended as a loss/)).toBeTruthy();
    fireEvent.click(screen.getByText('Apply to this combination'));
    expect(act).toHaveBeenCalledWith('/combo/apply', { id: 'a', force: false }, 'Breakout + Keltner: applied.');
    fireEvent.click(screen.getByText('Apply anyway…'));
    fireEvent.click(screen.getByText('Yes, apply'));
    expect(act).toHaveBeenCalledWith('/combo/apply', { id: 'b', force: true }, 'Aroon + Supertrend: applied anyway.');
    expect(screen.getByText('Nothing to change')).toBeTruthy();
    fireEvent.click(screen.getByText(/Tune each combination/));
    expect(act).toHaveBeenCalledWith('/run', { days: 30, what: 'combos' });
  });
});
