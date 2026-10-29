import { describe, expect, it } from 'vitest';
import { applyRequests, applyText, researchText } from './research.js';

describe('applyRequests', () => {
  it('sends the stop amount and ladder to the Account rules and the trail to the options settings', () => {
    const steps = [{ at: 1000, keep: 750 }];
    expect(applyRequests({ lossLimit: 2000, steps, trail: { points: 20, start: 20 } })).toEqual([
      { path: '/trade-defaults', body: { options: { stopLoss: 2000, steps } } },
      { path: '/options', body: { trailMode: 'points', trailPoints: 20, trailStart: 20 } },
    ]);
  });
  it('sends nothing for a row that cannot be applied', () => {
    expect(applyRequests(null)).toEqual([]);
    expect(applyRequests({})).toEqual([]);
  });
});

describe('applyText', () => {
  it('says what would change', () => {
    const t = applyText({ lossLimit: 2500, trail: { points: 30, start: 30 } });
    expect(t).toContain('₹2,500');
    expect(t).toContain('trailing stop: 30 points');
    expect(applyText(null)).toBe('');
  });
});

describe('researchText', () => {
  const row = { key: 'loss2000', group: 'stop', label: 'Most one trade may lose: ₹2,000', trades: 100, winRate: 60, net: 5000, maxDrawdown: 3000, verdict: 'Keep', train: { trades: 60, net: 3000 }, test: { trades: 40, net: 2000 } };
  const r = { entries: 'Breakout + Engulfing', signals: 500, split: true, base: { trades: 100, winRate: 60, net: 4000, maxDrawdown: 3500, train: { trades: 60, net: 2000 }, test: { trades: 40, net: 2000 } }, rows: [row], mix: null };
  it('lists the base, each group and the older and newer days', () => {
    const t = researchText(r);
    expect(t).toContain('Your settings now: 100 trades');
    expect(t).toContain('Stop amount:');
    expect(t).toContain('Most one trade may lose: ₹2,000: 100 trades');
    expect(t).toContain('older 60 trades');
  });
  it('handles a skipped run', () => {
    expect(researchText({ skipped: 'no signal' })).toBe('Research: no signal.');
    expect(researchText(null)).toBe('');
  });
});
