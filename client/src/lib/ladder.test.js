import { describe, expect, it } from 'vitest';
import { ladderSummary, minOfTime, nextRow, rowsFromRules, rowsProblem, stepsOf, timeText } from './ladder.js';

const rows = (...pairs) => pairs.map(([at, keep]) => ({ at: String(at), keep: String(keep) }));

describe('profit ladder rows', () => {
  it('reads the saved rule into rows and back', () => {
    const r = rowsFromRules({ steps: [{ at: 1000, keep: 750 }, { at: 2000, keep: 1700 }] });
    expect(r).toEqual(rows([1000, 750], [2000, 1700]));
    expect(stepsOf(r)).toEqual([{ at: 1000, keep: 750 }, { at: 2000, keep: 1700 }]);
    expect(stepsOf([{ at: '', keep: '' }])).toEqual([]);
  });

  it('refuses rows that do not rise or lock as much as the profit', () => {
    expect(rowsProblem(rows([1000, 750], [2000, 1700]))).toBeNull();
    expect(rowsProblem([])).toBeNull();
    expect(rowsProblem(rows([1000, 1000]))).toMatch(/Row 1/);
    expect(rowsProblem(rows([1000, 750], [900, 800]))).toMatch(/Row 2/);
    expect(rowsProblem(rows([1000, 750], [2000, 700]))).toMatch(/higher than the row above/);
    expect(rowsProblem([{ at: 'x', keep: '5' }])).toMatch(/numbers/);
    expect(rowsProblem(Array.from({ length: 9 }, (_, i) => ({ at: String(1000 * (i + 1)), keep: String(500 * (i + 1)) })))).toMatch(/at most 8/);
  });

  it('suggests a next row above the last one and words the ladder', () => {
    expect(nextRow([])).toEqual({ at: '1000', keep: '750' });
    expect(nextRow(rows([1000, 750]))).toEqual({ at: '1500', keep: '1250' });
    expect(ladderSummary([])).toBe('no lock');
    expect(ladderSummary([{ at: 1000, keep: 750 }])).toBe('lock from +₹1,000, ₹250 behind');
    expect(ladderSummary([{ at: 1000, keep: 750 }, { at: 3000, keep: 2500 }])).toMatch(/^lock ladder 2 rows/);
  });
});

describe('exit time', () => {
  it('turns a typed time into minutes and back, and refuses one outside 09:30 to 15:15', () => {
    expect(minOfTime('14:15')).toBe(855);
    expect(timeText(855)).toBe('14:15');
    expect(minOfTime('15:15')).toBe(915);
    expect(minOfTime('15:16')).toBeNull();
    expect(minOfTime('09:29')).toBeNull();
    expect(minOfTime('')).toBeNull();
  });
});
