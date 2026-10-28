import { describe, expect, it } from 'vitest';
import { dayText, jobPercent, savedText, sizeText, syncLabel } from './history.js';

describe('history helpers', () => {
  it('writes sizes in KB and MB', () => {
    expect(sizeText(0)).toBe('0 KB');
    expect(sizeText(500)).toBe('1 KB');
    expect(sizeText(820 * 1024)).toBe('820 KB');
    expect(sizeText(38.24 * 1024 * 1024)).toBe('38.2 MB');
  });

  it('writes a day and the saved range', () => {
    expect(dayText('2025-10-28')).toBe('28 Oct 2025');
    expect(dayText('nope')).toBe('');
    expect(savedText(null)).toBe('Nothing saved yet.');
    expect(savedText({ symbols: 51, days: 245, from: '2025-10-28', to: '2026-10-27', bytes: 38 * 1024 * 1024 })).toBe('51 symbols, 245 trading days, 28 Oct 2025 to 27 Oct 2026, 38.0 MB.');
  });

  it('labels the button and counts progress', () => {
    expect(syncLabel(null)).toBe('Download last 1 year');
    expect(syncLabel({ days: 3 })).toBe('Update now');
    expect(jobPercent({ done: 17, total: 51 })).toBe(33);
    expect(jobPercent({ done: 0, total: 0 })).toBe(0);
  });
});
