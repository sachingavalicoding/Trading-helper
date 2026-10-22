import { describe, it, expect } from 'vitest';
import { formatINR, formatCompactINR, formatPnl, formatPct, formatQtyCompact } from './format.js';

describe('Indian number formatting', () => {
  it('groups rupees in lakhs', () => {
    expect(formatINR(100000)).toBe('₹1,00,000.00');
    expect(formatINR(12345678.9)).toBe('₹1,23,45,678.90');
  });
  it('abbreviates lakh and crore', () => {
    expect(formatCompactINR(250000)).toBe('₹2.50 L');
    expect(formatCompactINR(31500000)).toBe('₹3.15 Cr');
    expect(formatCompactINR(-45200)).toBe('-₹45,200');
    expect(formatQtyCompact(24300000)).toBe('2.43 Cr');
  });
  it('signs P&L and percentages', () => {
    expect(formatPnl(1234.5)).toBe('+₹1,234.50');
    expect(formatPnl(-56)).toBe('-₹56.00');
    expect(formatPct(0.756)).toBe('+0.76%');
    expect(formatINR(undefined)).toBe('—');
  });
});
