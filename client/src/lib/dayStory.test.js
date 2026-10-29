import { describe, expect, it } from 'vitest';
import { dayType, legCount, storyLines } from './dayStory.js';

const clock = (t) => `t${t}`;
const base = { open: 24000, high: { price: 24210, time: 5 }, low: { price: 23990, time: 1 }, close: 24200, changePts: 200, rangePts: 220, atr5: 12, swing: 36, legs: [{ dir: 'up', from: 1, to: 5, fromPrice: 23990, toPrice: 24210, pts: 220 }, { dir: 'down', from: 5, to: 8, fromPrice: 24210, toPrice: 24150, pts: 60 }] };

describe('dayType', () => {
  it('calls a close that kept most of the range a trend day', () => {
    expect(dayType(base).key).toBe('trend-up');
    expect(dayType({ ...base, changePts: -200 }).key).toBe('trend-down');
  });
  it('calls a close near the open a range day, and the rest mixed', () => {
    expect(dayType({ ...base, changePts: 20 }).key).toBe('range');
    expect(dayType({ ...base, changePts: 100 }).key).toBe('mixed-up');
  });
  it('has nothing to say without a range', () => {
    expect(dayType(null)).toBe(null);
    expect(dayType({ ...base, rangePts: 0 })).toBe(null);
  });
});

describe('storyLines', () => {
  it('opens with the day and then one line per swing, naming the side that was right', () => {
    const lines = storyLines(base, clock);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('+200 points on a 220 point range');
    expect(lines[1]).toContain('A call (CE) was the right side');
    expect(lines[1]).toContain('about 110 points');
    expect(lines[2]).toContain('A put (PE) was the right side');
  });
  it('is empty without a story', () => {
    expect(storyLines(null, clock)).toEqual([]);
  });
});

describe('legCount', () => {
  it('counts swings each way', () => {
    expect(legCount(base)).toEqual({ total: 2, up: 1, down: 1 });
    expect(legCount(null)).toEqual({ total: 0, up: 0, down: 0 });
  });
});
