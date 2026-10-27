import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './copyText.js';

afterEach(() => vi.restoreAllMocks());

describe('copyText', () => {
  it('uses the clipboard API when there is one', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to selecting a hidden field, and says so when that fails too', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) }, configurable: true });
    document.execCommand = vi.fn().mockReturnValue(true);
    expect(await copyText('hello')).toBe(true);
    document.execCommand = vi.fn().mockReturnValue(false);
    expect(await copyText('hello')).toBe(false);
  });
});
