import { describe, it, expect } from 'vitest';
import { computeVwap, applyTick, IST_OFFSET_SEC } from './chart.js';

describe('VWAP', () => {
  it('is cumulative typical price x volume over volume', () => {
    const v = computeVwap([
      { time: 0, high: 102, low: 98, close: 100, volume: 100 },
      { time: 60, high: 112, low: 108, close: 110, volume: 300 },
    ]);
    expect(v[0].value).toBe(100);
    expect(v[1].value).toBe(107.5);
  });
  it('resets at the start of each day', () => {
    const v = computeVwap([
      { time: 86400 - 60, high: 100, low: 100, close: 100, volume: 10 },
      { time: 86400, high: 200, low: 200, close: 200, volume: 10 },
    ]);
    expect(v[1].value).toBe(200);
  });
});

describe('applyTick', () => {
  it('updates the current bar and opens a new one on the next bucket', () => {
    const t0 = 1_700_000_040; // seconds, aligned so bucket math is easy to follow
    const bucket = (t0 + IST_OFFSET_SEC) - ((t0 + IST_OFFSET_SEC) % 60);
    const candles = [{ time: bucket, open: 100, high: 100, low: 100, close: 100, volume: 0 }];
    const state = { lastVolume: 1000 };
    applyTick(candles, { ts: (t0 + 10) * 1000, ltp: 101, volume: 1050 }, 60, state);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ high: 101, close: 101, volume: 50 });
    applyTick(candles, { ts: (bucket - IST_OFFSET_SEC + 60) * 1000, ltp: 99, volume: 1060 }, 60, state);
    expect(candles).toHaveLength(2);
    expect(candles[1]).toMatchObject({ open: 99, volume: 10 });
  });
});
