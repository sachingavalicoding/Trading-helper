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

describe('combination and move helpers for Review', () => {
  it('keeps the names of your combinations whole and tags them MY on the chart', async () => {
    const { shortLabel, codeOf } = await import('./patternReview.js');
    expect(shortLabel('Mine: Break in trend')).toBe('Mine: Break in trend');
    expect(shortLabel('Breakout of the last hour')).toBe('Breakout');
    expect(codeOf('breakout')).toBe('BO');
    expect(codeOf('combo:trend')).toBe('MY');
  });

  it('traces a move to the signals near it, and says so when there were none', async () => {
    const { moveLines, whyText } = await import('./patternReview.js');
    const patterns = [{ key: 'breakout', label: 'Breakout of the last hour' }];
    const clock = (t) => `t${t}`;
    const lines = moveLines(
      [
        { side: 'CE', pts: 72.4, from: 10, to: 20, signals: [{ technique: 'breakout', time: 12, skipped: 'far', net: null }, { technique: 'breakout', time: 15, skipped: null, net: 820 }] },
        { side: 'PE', pts: 40, from: 30, to: 40, signals: [] },
      ],
      patterns,
      clock,
    );
    expect(lines[0]).toMatch(/^Up 72 points, t10 to t20/);
    expect(lines[0]).toMatch(/Breakout at t12 was skipped \(stop too far\); Breakout at t15 was traded: \+₹820/);
    expect(lines[1]).toMatch(/Down 40 points.*No signal formed/);
    expect(moveLines(null, patterns)).toEqual([]);
    expect(whyText([{ label: 'RSI above 50', held: true }, { label: 'MACD above zero', held: false }])).toBe('✓ RSI above 50  – MACD above zero');
  });
});

describe('offering new combinations', () => {
  it('switches a combination on once and leaves it alone afterwards', async () => {
    const { offerCombos } = await import('./patternReview.js');
    const patterns = [{ key: 'breakout' }, { key: 'combo:a', combo: true }, { key: 'combo:b', combo: true }];
    expect(offerCombos(['breakout'], [], patterns)).toEqual({ watch: ['breakout', 'combo:a', 'combo:b'], seen: ['combo:a', 'combo:b'] });
    expect(offerCombos(['breakout'], ['combo:a', 'combo:b'], patterns)).toBeNull();
    expect(offerCombos(['breakout'], ['combo:a'], patterns).watch).toEqual(['breakout', 'combo:b']);
  });
});

describe('indicator keys', () => {
  it('takes only the indicators out of the watch list and tags their arrows IND', async () => {
    const { checksOf, codeOf, offerCombos } = await import('./patternReview.js');
    expect(checksOf(['breakout', 'check:rsiAbove50', 'combo:x', 'check:macdZero'])).toEqual(['rsiAbove50', 'macdZero']);
    expect(codeOf('check:rsiAbove50')).toBe('IND');
    expect(offerCombos([], [], [{ key: 'combo:a', combo: true, off: true }, { key: 'combo:b', combo: true }]).watch).toEqual(['combo:b']);
  });
});
