import { afterEach, describe, expect, it, vi } from 'vitest';
import { everyVisible } from './visible.js';

const setHidden = (v) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });

describe('everyVisible', () => {
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('skips while hidden and catches up once on return', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const stop = everyVisible(fn, 1000);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    setHidden(true);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
