import { describe, it, expect } from 'vitest';
import { verdict, studyText, hourRows, istStamp, sizingText, sharesText, exitText } from './study.js';

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
  it('writes the shares study as text', () => {
    const row = (key, net) => ({ key, trades: 12, winRate: 50, totalNet: net, avgWin: 300, avgLoss: -200, profitFactor: 1.4 });
    const text = sharesText({
      period: { days: 10, stocks: 50 },
      params: { riskAmount: 200, slippagePct: 0.05 },
      overall: { trades: 40, winRate: 48, totalNet: 1200, totalCharges: 900, maxDrawdown: 700 },
      bySetup: [row('Opening range breakout', 900), row('News gap', -100)],
      bySide: [row('Buys', 500)],
      byHour: [row('09:00', 300)],
      byExit: [row('Stop hit', -600)],
      firstTarget: [{ target: 1, hitRate: 40, expectancyR: -0.2 }],
    });
    expect(text).toMatch(/Shares study, last 10 trading days, 50 stocks, each trade sized to risk ₹200/);
    expect(text).toMatch(/Opening range breakout: 12 trades, 50% win, net \+₹900\.00/);
    expect(text).toMatch(/1R: reached 40%, expectancy -0.2R/);
    expect(sharesText(null)).toBe('');
  });
});

it('the exit and the lots a study used are told in words', () => {
  expect(exitText({ exit: 'lock', lockStart: 1000, lockGap: 250 })).toBe('Profit lock +1000 keeps 750');
  expect(exitText({ exit: 'target', target: 1000 })).toMatch(/No profit lock.*\+₹1000 a lot/);
  expect(sizingText({ fixedLots: 1, lossLimit: 1500, maxLots: 2 })).toMatch(/^1 lot each/);
  expect(sizingText({ fixedLots: 0, lossLimit: 1500, maxLots: 2 })).toMatch(/sized/);
});
