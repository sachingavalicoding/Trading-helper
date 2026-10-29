import { describe, expect, it } from 'vitest';
import { resultLine, resultTone } from './results.js';

describe('resultLine', () => {
  it('reads an options row and a shares row', () => {
    expect(resultLine({ trades: 119, winRate: 61, net: 13658.89 })).toContain('61% win');
    expect(resultLine({ trades: 119, winRate: 61, net: 13658.89 })).toContain('119 trades');
    expect(resultLine({ trades: 40, winRate: 43, totalNet: -3000 })).toContain('40 trades');
  });
  it('says when there are too few trades', () => {
    expect(resultLine({ trades: 4, winRate: 25, net: -3200 })).toContain('too few');
  });
});

describe('resultTone', () => {
  it('colours by profit once there are enough trades', () => {
    expect(resultTone({ trades: 50, net: 100 })).toBe('text-up');
    expect(resultTone({ trades: 50, totalNet: -100 })).toBe('text-down');
    expect(resultTone({ trades: 3, net: 100 })).toBe('text-muted');
  });
});
