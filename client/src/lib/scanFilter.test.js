import { describe, expect, it } from 'vitest';
import { istMinutes, passesFilter } from './scanFilter.js';

describe('scanner filters', () => {
  // 05:30 UTC is 11:00 IST
  const idea = { score: 82, openedAt: '2026-10-26T05:30:00Z' };
  it('reads India time', () => expect(istMinutes(idea.openedAt)).toBe(11 * 60));
  it('filters by score', () => {
    expect(passesFilter(idea, { minScore: 80 })).toBe(true);
    expect(passesFilter(idea, { minScore: 90 })).toBe(false);
  });
  it('filters by time window', () => {
    expect(passesFilter(idea, { window: 'AM' })).toBe(true);
    expect(passesFilter(idea, { window: 'PM' })).toBe(false);
    expect(passesFilter({ score: 90 }, { window: 'PM' })).toBe(true); // no time on it: not hidden
  });
});
