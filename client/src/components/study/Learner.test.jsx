import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Learner, splitWords } from './Learner.jsx';

const pick = { name: 'Learner: EMA stack + RSI', conds: ['emaStack', 'rsiAbove50'], labels: ['EMA stack', 'RSI above 50'], side: 'CE', sideText: 'calls only', train: { trades: 12, net: 3200, winRate: 58 }, test: { trades: 6, net: 900, winRate: 67 } };
const view = {
  kind: 'options',
  auto: false,
  status: { state: 'idle' },
  last: { at: '2026-11-12T11:30:00Z', verdict: 'found', text: 'Found: EMA stack + RSI above 50 (calls only).', pick, baseline: { test: { trades: 8, net: 200 } }, candidates: [{ ...pick, passed: true, why: [] }, { ...pick, conds: ['macdZero'], labels: ['MACD above zero'], sideText: 'calls and puts', side: null, passed: false, why: ['lost money on the newest days it never saw'] }], tried: 400, trainDays: 20, testDays: 10, pricing: 'real' },
  slot: null,
  log: [{ at: '2026-11-12T11:30:00Z', action: 'checked', text: 'Found one' }],
  traderOff: false,
  note: 'Past results do not promise future ones.',
};
vi.mock('../../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve(view)) }));

describe('Learner', () => {
  it('shows the pick, the older and newest days, your combinations, the switch and Use it', async () => {
    render(<Learner />);
    expect(await screen.findByText('Found one')).toBeTruthy();
    expect(screen.getByText('EMA stack + RSI above 50')).toBeTruthy();
    expect(screen.getByText('Newest days (never seen)')).toBeTruthy();
    expect(screen.getByText('Your combinations, newest days')).toBeTruthy();
    expect(screen.getByRole('switch')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use it' })).toBeTruthy();
  });
});

describe('splitWords', () => {
  it('says which days picked and which checked, and whether option prices were real', () => {
    expect(splitWords({ trainDays: 20, testDays: 10, pricing: 'real' })).toBe('Picked on the older 20 days, then checked on the newest 10 days it never saw. After charges. Real saved option prices.');
    expect(splitWords({ trainDays: 10, testDays: 5, pricing: 'estimated' })).toContain('estimated');
    expect(splitWords({ trainDays: 10, testDays: 5, pricing: null })).not.toContain('option');
    expect(splitWords(null)).toBe('');
  });
});
