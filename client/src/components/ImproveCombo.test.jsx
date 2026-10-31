import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImproveCombo } from './ImproveCombo.jsx';

vi.mock('../lib/useApi.js', () => ({ useApi: () => ({ data: { settings: { combos: [] } }, reload: () => {} }) }));
vi.mock('../lib/api.js', () => ({ api: vi.fn() }));

const improve = {
  id: 'm',
  name: 'Breakout + RSI',
  conds: ['a', 'b'],
  add: [],
  base: { trades: 6, wins: 4, net: 3000 },
  rows: [
    { key: 'ema', label: 'EMA 9 above EMA 21', group: 'Trend', kept: { trades: 4, wins: 4, net: 9000 }, skipped: { trades: 2, losers: 2, losersNet: -4100, winners: 0, winnersNet: 0 }, added: { trades: 0, net: 0 }, gain: 4100 },
    { key: 'vol', label: 'Volume 1.5 times the usual', group: 'Volume', kept: { trades: 3, wins: 2, net: 1000 }, skipped: { trades: 3, losers: 1, losersNet: -900, winners: 2, winnersNet: 5000 }, added: { trades: 0, net: 0 }, gain: -4100 },
  ],
};

describe('ImproveCombo', () => {
  it('shows the combination now, ranks the indicators and sends the picks up', () => {
    const setTrial = vi.fn();
    render(<ImproveCombo combos={[{ id: 'm', name: 'Breakout + RSI' }]} trial={{ id: 'm', add: [] }} setTrial={setTrial} improve={improve} newEntries={null} loading={false} />);
    expect(screen.getByText('6 entries, 4 won, 2 lost')).toBeTruthy();
    expect(screen.getByText(/skips 2 entries \(2 losers/)).toBeTruthy();
    expect(screen.getByText(/saves/)).toBeTruthy();
    expect(screen.getByText(/costs/)).toBeTruthy();
    fireEvent.click(screen.getByText(/EMA 9 above EMA 21/));
    expect(setTrial).toHaveBeenCalledWith({ id: 'm', add: ['ema'] });
  });
  it('shows the new combination beside the old one once something is picked', () => {
    const entries = [{ id: 'x', lock: { net: 5000 }, target: { net: 1 } }, { id: 'y', lock: { net: 4000 }, target: { net: 1 } }];
    render(<ImproveCombo combos={[{ id: 'm', name: 'Breakout + RSI' }]} trial={{ id: 'm', add: ['ema'] }} setTrial={() => {}} improve={{ ...improve, add: ['ema'] }} newEntries={entries} loading={false} />);
    expect(screen.getByText('2 entries, 2 won, 0 lost')).toBeTruthy();
    expect(screen.getByText('Save as a new combination (off)')).toBeTruthy();
  });
});
