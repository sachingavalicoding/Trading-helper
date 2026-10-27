import { describe, expect, it } from 'vitest';
import { insightsOf, sortRows } from './insights.js';

const tick = { ltp: 108, open: 102, high: 110, low: 100, prevClose: 100, atp: 105 };

describe('insightsOf', () => {
  it('reads range position, VWAP, gap and move from the open', () => {
    const i = insightsOf(tick);
    expect(i.rangePos).toBeCloseTo(0.8);
    expect(i.vsVwapPct).toBeCloseTo(2.857, 2);
    expect(i.gapPct).toBeCloseTo(2);
    expect(i.fromOpenPct).toBeCloseTo(5.882, 2);
    expect(i.mood).toBe('Strong');
  });
  it('calls a stock weak when it sits under VWAP and its open near the low', () => {
    expect(insightsOf({ ...tick, ltp: 101 }).mood).toBe('Weak');
    expect(insightsOf({ ...tick, ltp: 104 }).mood).toBe('Mixed');
  });
  it('has nothing to say without a price, and survives a flat day', () => {
    expect(insightsOf(null)).toBeNull();
    expect(insightsOf({ ltp: 100, open: 100, high: 100, low: 100 }).rangePos).toBeNull();
  });
});

describe('sortRows', () => {
  const rows = [
    { stock: { symbol: 'B' }, tick: { changePct: 1 } },
    { stock: { symbol: 'A' }, tick: { changePct: 3 } },
    { stock: { symbol: 'C' }, tick: null },
    { stock: { symbol: 'D' }, tick: { changePct: -2 } },
  ];
  it('sorts by a column and always puts rows without a value last', () => {
    expect(sortRows(rows, 'change', 'desc').map((r) => r.stock.symbol)).toEqual(['A', 'B', 'D', 'C']);
    expect(sortRows(rows, 'change', 'asc').map((r) => r.stock.symbol)).toEqual(['D', 'B', 'A', 'C']);
  });
  it('sorts by name', () => {
    expect(sortRows(rows, 'symbol', 'asc').map((r) => r.stock.symbol)).toEqual(['A', 'B', 'C', 'D']);
  });
});
