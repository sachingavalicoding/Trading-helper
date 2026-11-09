import { describe, expect, it } from 'vitest';
import { entryClock, exampleWords } from './examples.js';

describe('info button chart words', () => {
  it('says when it never fired', () => {
    expect(exampleWords({ days: 5, summary: { entries: 0, calls: 0, puts: 0, right: 0, avgAfter: null, avgBest: null } })).toBe('It did not fire on the last 5 days.');
  });
  it('counts entries and the move after them', () => {
    const t = exampleWords({ days: 3, summary: { entries: 4, calls: 3, puts: 1, right: 3, avgAfter: 12.5, avgBest: 20 } });
    expect(t).toContain('4 entries in 3 days (3 calls, 1 put)');
    expect(t).toContain('3 times, on average +12.5 points');
  });
  it('shows the time in IST', () => {
    expect(entryClock(Date.UTC(2026, 10, 3, 4, 5) / 1000)).toMatch(/^09:35, Tue 3 Nov$/);
  });
});
