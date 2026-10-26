import { describe, expect, it } from 'vitest';
import { rankMovers } from './movers.js';

describe('rankMovers', () => {
  const ticks = [
    { symbol: 'A', changePct: -2 },
    { symbol: 'B', changePct: 1.5 },
    { symbol: 'C', changePct: 0.1 },
    { symbol: 'D', changePct: NaN },
  ];
  it('puts the stocks lagging the index first and skips missing data', () => {
    const r = rankMovers(ticks, 0.5, 2);
    expect(r.weakest.map((x) => x.symbol)).toEqual(['A', 'C']);
    expect(r.strongest.map((x) => x.symbol)).toEqual(['B', 'C']);
    expect(r.weakest[0].vsNifty).toBeCloseTo(-2.5);
  });
});
