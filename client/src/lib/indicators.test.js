import { describe, it, expect } from 'vitest';
import { sma, ema, bollinger, rsi, macd } from './indicators.js';

const bars = (closes) => closes.map((close, i) => ({ time: i * 60, open: close, high: close, low: close, close, volume: 100 }));

describe('indicators', () => {
  it('SMA averages the last N closes', () => {
    expect(sma(bars([1, 2, 3, 4, 5]), 3).map((p) => p.value)).toEqual([2, 3, 4]);
  });

  it('EMA is seeded with the SMA and weights recent prices more', () => {
    const v = ema(bars([1, 2, 3, 4, 5]), 3).map((p) => p.value);
    expect(v[0]).toBe(2); // SMA seed
    expect(v[1]).toBe(3); // 4*0.5 + 2*0.5
    expect(v[2]).toBe(4);
  });

  it('Bollinger bands are symmetric around the SMA', () => {
    const { upper, middle, lower } = bollinger(bars([2, 4, 4, 4, 5, 5, 7, 9]), 8, 2);
    expect(middle[0].value).toBe(5);
    expect(upper[0].value).toBe(9); // population SD of this classic series is 2
    expect(lower[0].value).toBe(1);
  });

  it('RSI is 100 in a straight rally and 0 in a straight decline', () => {
    expect(rsi(bars([1, 2, 3, 4, 5, 6]), 3).every((p) => p.value === 100)).toBe(true);
    expect(rsi(bars([6, 5, 4, 3, 2, 1]), 3).every((p) => p.value === 0)).toBe(true);
  });

  it('MACD of a flat series is zero and histogram = line - signal', () => {
    const flat = macd(bars(Array(40).fill(100)));
    expect(flat.line.every((p) => p.value === 0)).toBe(true);
    const trending = macd(bars(Array.from({ length: 60 }, (_, i) => 100 + i)));
    const last = trending.histogram.at(-1).value;
    expect(last).toBeCloseTo(trending.line.at(-1).value - trending.signal.at(-1).value, 1);
    expect(trending.line.at(-1).value).toBeGreaterThan(0);
  });
});
