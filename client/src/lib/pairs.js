import { formatPnl } from './format.js';
import { bestOf, comboResearchText } from './research.js';

const part = (p) => `${p.trades} trades, ${p.winRate ?? '-'}% win, ${formatPnl(p.net)}`;

/** The entries a result removed from its starting combination, in words ("skips 12 entries: 9 losers (-₹8,100), 3 winners (+₹2,000)"). */
export function skipsText(f) {
  const k = f.skips;
  if (!k) return f.skipped > 0 ? `skips ${f.skipped} entries` : '';
  if (!k.trades) return 'skips no entries';
  return `skips ${k.trades} entries: ${k.losers} losers (${formatPnl(k.losersNet)}), ${k.winners} winners (${formatPnl(k.winnersNet)})`;
}

/** The best result of a finder run, by its goal: { anchor, f } or null. */
export function winnerOf(pf) {
  if (!pf?.anchors) return null;
  const rows = pf.anchors.flatMap((a) => a.found.map((f) => ({ anchor: a, f })));
  const score = pf.goal === 'winrate' ? ({ f }) => (f.winRate ?? 0) * 1e6 + f.test.net : ({ f }) => f.test.net;
  return rows.sort((x, y) => score(y) - score(x))[0] ?? null;
}

/** The best result with the stop and profit setting that went with it, as one sentence. */
export function winnerText(pf) {
  const w = winnerOf(pf);
  if (!w) return '';
  const { anchor: a, f } = w;
  const { stop, exit } = bestOf(f.research);
  const parts = [`Best found: ${a.label} + ${[].concat(f.added).join(' + ')}: ${f.trades} trades, ${f.winRate ?? '-'}% win (${a.label} alone ${a.winRate ?? '-'}%), ${formatPnl(f.net)} (alone ${formatPnl(a.net)}); newer days ${part(f.test)}`];
  const sk = skipsText(f);
  if (sk) parts.push(sk);
  if (stop) parts.push(`stop: ${stop.label.replace(/^Stop /, '')}`);
  if (exit) parts.push(`profit: ${exit.label}`);
  return parts.join('; ') + '.';
}

/** The pair finder result as plain text, to paste into the chat. `callWord`/`putWord` name the two sides. */
export function pairsText(pf, callWord = 'Calls', putWord = 'Puts') {
  if (!pf) return '';
  if (pf.skipped) return `\nPair finder: ${pf.skipped}.`;
  const win = winnerText(pf);
  const lines = ['', ...(win ? [win, ''] : []), `Pair finder (${pf.tried} pairs tried; learned on the older ${pf.trainDays} days, checked on the newer ${pf.testDays} days it had not seen):`];
  for (const a of pf.anchors) {
    lines.push(`Starting from ${a.label}: ${part(a)}; older ${part(a.train)}; newer ${part(a.test)}`);
    if (a.research) lines.push(comboResearchText(a.research, a.label));
    if (!a.found.length) lines.push('  No partner made money on both the older and the newer days.');
    for (const f of a.found) {
      const name = [].concat(f.added ?? f.labels[1]).join(' + ');
      lines.push(`  + ${name}: ${f.trades} trades, ${f.winRate ?? '-'}% win, ${formatPnl(f.net)} (${formatPnl(f.lift)} against ${a.label} alone, win rate ${a.winRate ?? '-'}% to ${f.winRate ?? '-'}%${skipsText(f) ? `, ${skipsText(f)}` : ''}); ${callWord} ${formatPnl(f.calls.net)}, ${putWord} ${formatPnl(f.puts.net)}; older ${part(f.train)}; newer ${part(f.test)}`);
      if (f.research) lines.push(comboResearchText(f.research, `${a.label} + ${name}`));
    }
  }
  return lines.join('\n');
}
