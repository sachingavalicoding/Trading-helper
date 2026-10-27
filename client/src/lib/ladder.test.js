import { describe, expect, it } from 'vitest';
import { nextRung, readLadder, sameLadder } from './ladder.js';

describe('readLadder', () => {
  it('turns typed rows into numbers', () => {
    expect(readLadder([{ at: '700', keep: '400' }, { at: '1000', keep: '700' }])).toEqual({ rows: [{ at: 700, keep: 400 }, { at: 1000, keep: 700 }] });
  });
  it('says what is wrong', () => {
    expect(readLadder([{ at: '', keep: '400' }]).error).toMatch(/fill in/);
    expect(readLadder([{ at: '300', keep: '500' }]).error).toMatch(/larger than the profit it keeps/);
    expect(readLadder([{ at: '700', keep: '400' }, { at: '600', keep: '500' }]).error).toMatch(/larger than the rung above/);
    expect(readLadder([]).error).toMatch(/at least one/);
  });
});

describe('nextRung', () => {
  it('offers a rung further up', () => {
    expect(nextRung([{ at: '700', keep: '400' }], 50)).toEqual({ at: '1050', keep: '600' });
    expect(nextRung([], 50)).toEqual({ at: '', keep: '' });
  });
});

describe('sameLadder', () => {
  it('compares by number', () => {
    expect(sameLadder([{ at: '700', keep: '400' }], [{ at: 700, keep: 400 }])).toBe(true);
    expect(sameLadder([{ at: '700', keep: '400' }], [{ at: 700, keep: 401 }])).toBe(false);
  });
});
