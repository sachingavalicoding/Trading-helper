import { describe, it, expect } from 'vitest';
import { winIntro } from './WinFinder.jsx';

describe('winIntro', () => {
  it('says the window, the tries, the rule and warns that a short window can be luck', () => {
    const t = winIntro({ tried: 455, pool: new Array(14), days: 5, matches: 3, minWin: 70, minTrades: 5, found: [1, 2, 3] });
    expect(t).toContain('455 combinations');
    expect(t).toContain('last 5 trading days');
    expect(t).toContain('at least 70% of at least 5 trades');
    expect(t).toContain('luck');
  });
});
