import { formatPnl } from './format.js';

const part = (p) => `${p.trades} trades, ${p.winRate ?? '-'}% win, ${formatPnl(p.net)}`;

/** The pair finder result as plain text, to paste into the chat. `callWord`/`putWord` name the two sides. */
export function pairsText(pf, callWord = 'Calls', putWord = 'Puts') {
  if (!pf) return '';
  if (pf.skipped) return `\nPair finder: ${pf.skipped}.`;
  const lines = ['', `Pair finder (${pf.tried} pairs tried; learned on the older ${pf.trainDays} days, checked on the newer ${pf.testDays} days it had not seen):`];
  for (const a of pf.anchors) {
    lines.push(`Starting from ${a.label}: ${part(a)}; older ${part(a.train)}; newer ${part(a.test)}`);
    if (!a.found.length) lines.push('  No partner made money on both the older and the newer days.');
    for (const f of a.found) lines.push(`  + ${f.added ?? f.labels[1]}: ${f.trades} trades, ${f.winRate ?? '-'}% win, ${formatPnl(f.net)} (${formatPnl(f.lift)} against ${a.label} alone); ${callWord} ${formatPnl(f.calls.net)}, ${putWord} ${formatPnl(f.puts.net)}; older ${part(f.train)}; newer ${part(f.test)}`);
  }
  return lines.join('\n');
}
