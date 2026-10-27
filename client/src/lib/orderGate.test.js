import { describe, expect, it } from 'vitest';
import { orderBlock } from './orderGate.js';

// IST = UTC + 5:30, so 09:20 IST is 03:50 UTC.
const at = (hh, mm) => new Date(Date.UTC(2026, 9, 27, hh, mm) - 330 * 60000);
const live = { enforced: true, tradingDay: true, phase: 'OPEN' };

describe('orderBlock', () => {
  it('lets you trade during market hours', () => {
    expect(orderBlock(live, at(9, 20))).toBeNull();
    expect(orderBlock(live, at(15, 14))).toBeNull();
  });
  it('blocks before the open, after 15:15 and after the close', () => {
    expect(orderBlock(live, at(9, 0))).toMatch(/opens at 09:15/);
    expect(orderBlock(live, at(15, 15))).toMatch(/15:15/);
    expect(orderBlock(live, at(15, 40))).toMatch(/closed/);
  });
  it('blocks on weekends and holidays', () => {
    expect(orderBlock({ ...live, tradingDay: false, phase: 'WEEKEND' }, at(11, 0))).toMatch(/Weekend/);
    expect(orderBlock({ ...live, tradingDay: false, phase: 'HOLIDAY' }, at(11, 0))).toMatch(/holiday/);
  });
  it('never blocks in practice mode', () => {
    expect(orderBlock({ ...live, enforced: false, tradingDay: false }, at(22, 0))).toBeNull();
    expect(orderBlock(null)).toBeNull();
  });
});
