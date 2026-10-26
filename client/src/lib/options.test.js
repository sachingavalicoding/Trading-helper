import { describe, it, expect } from 'vitest';
import { scoreTone, shortExpiry, lotsOf, premiumGain } from './options.js';

describe('options helpers', () => {
  it('colours a reading by how close it is to the entry score', () => {
    expect(scoreTone(80)).toBe('up');
    expect(scoreTone(62)).toBe('warn');
    expect(scoreTone(40)).toBe('muted');
    expect(scoreTone(null)).toBe('muted');
  });
  it('shortens an expiry date', () => {
    expect(shortExpiry('2026-11-03')).toBe('3 Nov');
    expect(shortExpiry('')).toBe('');
  });
  it('counts lots', () => {
    expect(lotsOf(130, 65)).toBe(2);
    expect(lotsOf(-65, 65)).toBe(1);
  });
  it('gives the premium gain as a share of the entry', () => {
    expect(premiumGain(150, 100)).toBe(0.5);
    expect(premiumGain(null, 100)).toBe(null);
  });
});
