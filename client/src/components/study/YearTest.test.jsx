import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { YearTest } from './YearTest.jsx';

const run = {
  spec: { side: 'options', what: 'score' }, label: 'Options: score bot (score entries only)', state: 'done', step: '', error: '',
  months: [{ month: '2026-05', done: true, days: 21 }],
  check: { rows: [{ day: '2026-11-19', fast: { trades: 2, net: 500 }, full: { trades: 5, net: -1200 } }], verdict: { trusted: false, text: 'They differ a lot: do NOT trust the fast result.' } },
  result: { trades: 3, wins: 2, winRate: 67, net: 900, days: 21, greenDays: 2, redDays: 1, withoutBestDay: -100, perMonth: [{ key: '2026-05', days: 21, trades: 3, winRate: 67, net: 900 }], perEntry: [{ key: 'Score: breakout', trades: 3, winRate: 67, net: 900 }], bestMonth: { key: '2026-05', net: 900 }, worstMonth: null, bestDay: { day: '2026-05-04', net: 1000 }, worstDay: { day: '2026-05-05', net: -300 }, untouched: { from: '2026-10-05', days: 3, trades: 3, winRate: 67, net: 900 }, secondsPerDay: 0.2, seconds: 4 },
};
vi.mock('../../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({ run, data: { nifty: { from: '2025-11-20', to: '2026-11-19', days: 248 }, shares: { from: null, to: null, days: 0 } }, combos: { shares: [], options: [] }, setups: ['Trend score'], monthChoices: [1, 3, 6, 12], note: 'Fast test.' })) }));

describe('YearTest', () => {
  it('shows the result, the estimated-price warning and an untrusted check', async () => {
    render(<YearTest />);
    expect(await screen.findByText(/premiums are ESTIMATED/)).toBeTruthy();
    expect(screen.getByText(/do NOT trust the fast result/)).toBeTruthy();
    expect(screen.getByText(/Days never used for tuning/)).toBeTruthy();
    expect(screen.getByText('Score: breakout')).toBeTruthy();
  });
});
