import { formatPnl } from './format.js';

const FEW = 15; // under this many trades a result says nothing

/** A study row (options technique `{ trades, winRate, net }`, or shares setup `{ trades, winRate, totalNet }`) in one line: "61% win · +₹13,659 · 119 trades". */
export function resultLine(r) {
  const net = r.net ?? r.totalNet;
  return `${r.winRate ?? '–'}% win · ${formatPnl(net)} · ${r.trades} trades${r.trades < FEW ? ' (too few to trust)' : ''}`;
}

/** Green when it made money on enough trades, red when it lost, grey when there were too few. */
export function resultTone(r) {
  const net = r.net ?? r.totalNet;
  if (r.trades < FEW) return 'text-muted';
  return net > 0 ? 'text-up' : 'text-down';
}
