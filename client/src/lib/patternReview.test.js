import { describe, expect, it } from 'vitest';
import { afterText, dayTotals, exitLine, shortLabel, skipText, watched } from './patternReview.js';

const sig = (technique, lock, target, skipped) => ({ technique, skipped, lock: lock == null ? null : { net: lock }, target: target == null ? null : { net: target } });

describe('pattern review helpers', () => {
  it('shortens a pattern label to its first words', () => {
    expect(shortLabel('Breakout of the last hour')).toBe('Breakout');
    expect(shortLabel('Engulfing candle at a low / high')).toBe('Engulfing candle');
    expect(shortLabel('EMA 9 / 21 cross')).toBe('EMA 9');
  });

  it('keeps only the watched patterns and totals what they made', () => {
    const all = [sig('breakout', 800, 1000), sig('pinBar', -500, -500), sig('engulfing', -900, 1000), sig('breakout', null, null, 'far')];
    const mine = watched(all, ['breakout', 'engulfing']);
    expect(mine).toHaveLength(3);
    expect(dayTotals(mine)).toEqual({ signals: 3, traded: 2, skipped: 1, lock: -100, target: 2000, lockWins: 1, targetWins: 2 });
  });

  it('explains a skipped signal, an exit and the path after the entry', () => {
    expect(skipText({ skipped: 'far' })).toMatch(/too far/);
    expect(skipText({ skipped: 'limit' }, { lossLimit: 1500 })).toMatch(/₹1500/);
    expect(exitLine({ reason: 'LOCK', exitTime: 1, net: 820, lots: 2, minutes: 34 }, () => '11:42')).toBe('Profit lock at 11:42: +₹820.00 (2 lots, 34 min)');
    expect(afterText({ best: { pts: 41.2, minutes: 22 }, worst: { pts: -9, minutes: 3 }, after: 30 })).toBe('Within an hour the index went +41 points your way (after 22 min) and 9 points against you (after 3 min). An hour later it stood +30.');
  });
});
