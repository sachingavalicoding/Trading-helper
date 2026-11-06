import { describe, it, expect } from 'vitest';
import { markerTime } from './DayChart.jsx';
import { toChartTime } from '../lib/chart.js';

// A 5-minute signal candle 10:25-10:30 closes; the trade is bought at 10:30.
const at = (h, m) => Date.UTC(2026, 10, 6, h - 5, m - 30) / 1000; // IST clock time as epoch seconds
const buy = at(10, 30);

describe('markerTime', () => {
  it('puts the entry arrow on the buying minute on 1-minute bars', () => {
    const times = [25, 26, 27, 28, 29, 30, 31].map((m) => toChartTime(at(10, m)));
    expect(markerTime(times, { time: buy, entry: true }, '1m')).toBe(toChartTime(at(10, 30)));
  });

  it('puts it on the signal candle that closed on 5-minute bars', () => {
    const times = [20, 25, 30, 35].map((m) => toChartTime(at(10, m)));
    expect(markerTime(times, { time: buy, entry: true }, '5m')).toBe(toChartTime(at(10, 25)));
  });

  it('leaves other markers on the bar their moment falls in', () => {
    const times = [20, 25, 30, 35].map((m) => toChartTime(at(10, m)));
    expect(markerTime(times, { time: buy }, '5m')).toBe(toChartTime(at(10, 30)));
  });
});
