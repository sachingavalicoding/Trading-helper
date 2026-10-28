import { describe, it, expect } from 'vitest';
import { verdict, studyText, hourRows, istStamp, sizingText } from './study.js';

const tech = (over = {}) => ({ key: 'x', label: 'Breakout', trades: 20, wins: 11, winRate: 55, net: 4000, avgWin: 900, avgLoss: -500, best: 2500, worst: -1300, maxDrawdown: 1800, profitFactor: 1.8, signals: 30, skippedWide: 4, bySide: { CE: { trades: 12, wins: 7, net: 3000 }, PE: { trades: 8, wins: 4, net: 1000 } }, byHour: { 11: { trades: 5, net: 900 }, 10: { trades: 7, net: 1200 } }, ...over });

describe('study helpers', () => {
  it('says how far to trust a result', () => {
    expect(verdict(tech()).tone).toBe('up');
    expect(verdict(tech({ net: 300, profitFactor: 1.05 })).tone).toBe('warn');
    expect(verdict(tech({ net: -900, profitFactor: 0.8 })).tone).toBe('down');
    expect(verdict(tech({ trades: 4 })).tone).toBe('muted');
    expect(verdict(null).text).toMatch(/0 trades/);
  });
  it('lists hours in time order', () => {
    expect(hourRows(tech()).map((r) => r.hour)).toEqual(['10:00', '11:00']);
    expect(hourRows(null)).toEqual([]);
  });
  it('formats an IST time stamp', () => {
    expect(istStamp(Date.UTC(2026, 9, 13, 5, 5) / 1000)).toBe('13 Oct 10:35');
    expect(istStamp(undefined)).toBe('');
  });
  it('writes the study as text with every technique and the breadth rows', () => {
    const text = studyText({
      period: { from: '2026-10-01', to: '2026-10-28', days: 20 },
      params: { iv: 0.14, lockStart: 1000, lockGap: 250, maxPerDay: 3, maxStopAtr: 2.5 },
      techniques: [tech(), tech({ label: 'Pullback in a trend', net: -200 })],
      botBreakdown: { byTrigger: [{ key: 'Breakout', trades: 12, winRate: 60, net: 2500, avgWin: 900, avgLoss: -600 }], byScore: [], bySide: [{ key: 'Calls', trades: 5, winRate: 40, net: -800, avgWin: 700, avgLoss: -900 }] },
      breadth: [{ share: 70, side: 'down', episodes: 9, avg30: 12.5, hit30: 66, avg60: 20, hit60: 70 }],
    });
    expect(text).toMatch(/Breakout: 20 trades, 55% win, net \+₹4,000\.00/);
    expect(text).toMatch(/Pullback in a trend/);
    expect(text).toMatch(/70%\+ down: 9 times, next 30 min 12.5 pts \(66% right\)/);
    expect(text).toMatch(/keeps 750/);
    expect(text).toMatch(/one lot each/);
    expect(text).toMatch(/By entry Breakout: 12 trades, 60% win, net \+₹2,500\.00/);
    expect(text).toMatch(/By side Calls: 5 trades/);
    expect(sizingText({ lossLimit: 1500, maxLots: 2 })).toMatch(/₹1500.*1 to 2 lots/);
    expect(studyText(null)).toBe('');
  });
});
