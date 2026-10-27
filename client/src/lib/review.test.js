import { describe, expect, it } from 'vitest';
import { pctText, shiftDay, takeaways } from './review.js';

describe('review helpers', () => {
  it('formats signed percentages and shifts days', () => {
    expect(pctText(1.256)).toBe('+1.26%');
    expect(pctText(-0.4)).toBe('-0.40%');
    expect(pctText(null)).toBe('—');
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('says there is not enough data when samples are tiny', () => {
    expect(takeaways({ scanner: { byFamily: [{ key: 'Breakout', count: 2, winRate: 50, totalR: 1 }], byCheck: [] }, news: { byCategory: [] }, trades: { equity: { bySetup: [] } } })[0]).toMatch(/Not enough/);
    expect(takeaways(null)).toEqual([]);
  });

  it('names the best and worst family, the check that helped and the news that held', () => {
    const lines = takeaways({
      scanner: {
        byFamily: [
          { key: 'Trend follow', count: 30, winRate: 40, totalR: 6.5 },
          { key: 'Breakout', count: 25, winRate: 20, totalR: -8 },
        ],
        byCheck: [
          { id: 'rsi', label: 'RSI', withCount: 20, withAvgR: 0.1, withoutCount: 18, withoutAvgR: -0.1, liftR: 0.2 },
          { id: 'volume', label: 'Volume', withCount: 15, withAvgR: 0.4, withoutCount: 22, withoutAvgR: -0.2, liftR: 0.6 },
        ],
      },
      news: { byCategory: [{ key: 'ORDER_WIN', hits: 7, misses: 3, hitRate: 70, avgEdgePct: 0.8 }, { key: 'BROKERAGE', hits: 2, misses: 6, hitRate: 25, avgEdgePct: -0.5 }] },
      trades: { equity: { bySetup: [{ key: 'VWAP pullback', trades: 6, netPnl: 1840 }] } },
    });
    const text = lines.join('\n');
    expect(text).toMatch(/Trend follow made the most: \+6.5R/);
    expect(text).toMatch(/Breakout lost the most: -8R/);
    expect(text).toMatch(/Volume helped most: .*0.4R against -0.2R/);
    expect(text).toMatch(/RSI: 0.1R when it supported/);
    expect(text).toMatch(/order win was followed by the price 70%/);
    expect(text).toMatch(/brokerage did not hold/);
    expect(text).toMatch(/VWAP pullback earned ₹1,840/);
  });
});
