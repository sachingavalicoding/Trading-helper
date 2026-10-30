import { describe, expect, it } from 'vitest';
import { INDEXES, indexOf, indexWords, loadIndex, saveIndex } from './indexes.js';

describe('indexes', () => {
  it('knows the Nifty and the Sensex by the names the feed uses', () => {
    expect(INDEXES.map((i) => [i.key, i.symbol])).toEqual([
      ['NIFTY', 'NIFTY 50'],
      ['SENSEX', 'SENSEX'],
    ]);
    expect(indexOf('SENSEX').short).toBe('Sensex');
    expect(indexOf('nope').key).toBe('NIFTY');
  });

  it('writes a list of indexes in words', () => {
    expect(indexWords(['NIFTY'])).toBe('Nifty');
    expect(indexWords(['NIFTY', 'SENSEX'])).toBe('Nifty and Sensex');
  });

  it('remembers the index you looked at last, Nifty at first', () => {
    localStorage.clear();
    expect(loadIndex()).toBe('NIFTY');
    saveIndex('SENSEX');
    expect(loadIndex()).toBe('SENSEX');
    localStorage.setItem('npt_options_index', 'DAX');
    expect(loadIndex()).toBe('NIFTY');
  });
});
