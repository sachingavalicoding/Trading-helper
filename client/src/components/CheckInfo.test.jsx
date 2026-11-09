import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InfoButton } from './CheckInfo.jsx';

const how = { name: 'RSI (relative strength index)', what: 'Compares up closes with down closes.', idea: null, when: 'RSI (14) above 50. Buying pressure leads.', put: 'For a put it is turned upside down.', counts: 'It is a state.', needs: null, note: 'Closed bars only.' };
vi.mock('../lib/api.js', () => ({
  api: vi.fn((path) => (String(path).startsWith('/lab/examples') ? Promise.resolve({ days: 5, bars: [], entries: [], summary: { entries: 0, calls: 0, puts: 0, right: 0, avgAfter: null, avgBest: null } }) : Promise.resolve({ conditions: [
    { key: 'rsiAbove50', label: 'RSI (14) above 50', kind: 'state', how },
    { key: 'p_breakout', label: 'Breakout of the last hour', kind: 'event', how: { ...how, name: 'Chart pattern', what: null, idea: 'Price clears the top of the last hour.', when: 'Breakout of the last hour. A close above the last 12 highs.' } },
  ] }))),
}));

describe('InfoButton', () => {
  it('opens a sheet that says how a check works and when it triggers', async () => {
    render(<InfoButton keys="rsiAbove50" title="RSI (14) above 50" />);
    fireEvent.click(screen.getByLabelText('About RSI (14) above 50'));
    expect(await screen.findByText(/Buying pressure leads/)).toBeTruthy();
    expect(screen.getByText(/Compares up closes/)).toBeTruthy();
    expect(await screen.findByText('Where it would have bought')).toBeTruthy();
    expect(await screen.findByText('It did not fire on the last 5 days.')).toBeTruthy();
  });
  it('finds a study pattern by its own key', async () => {
    render(<InfoButton keys={['breakout']} title="Breakout" />);
    fireEvent.click(screen.getByLabelText('About Breakout'));
    expect(await screen.findByText(/clears the top of the last hour/)).toBeTruthy();
  });
});
