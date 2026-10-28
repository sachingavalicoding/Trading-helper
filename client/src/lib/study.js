import { formatPnl } from './format.js';

export const EXIT_WORD = { STOP: 'Stop hit', LOCK: 'Profit lock', EOD: '15:00 close' };
export const FEW_TRADES = 10; // under this many trades a result is mostly luck

/** "13 Oct 10:35" in IST, from epoch seconds. */
export function istStamp(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(seconds * 1000));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/** How much to trust a technique's result: too few trades, or a loser, or a winner. */
export function verdict(t) {
  if (!t || t.trades < FEW_TRADES) return { tone: 'muted', text: `Only ${t?.trades ?? 0} ${t?.trades === 1 ? 'trade' : 'trades'}, too few to trust` };
  if (t.net > 0 && t.profitFactor != null && t.profitFactor >= 1.3) return { tone: 'up', text: 'Made money' };
  if (t.net > 0) return { tone: 'warn', text: 'Barely positive' };
  return { tone: 'down', text: 'Lost money' };
}

const hourWord = (h) => `${h}:00`;

/** The whole study as plain text, to paste into the chat. */
/** How many lots each trade used, in words. */
export const sizingText = (p) => (p.lossLimit > 0 ? `lots sized so the loss at the stop stays within ₹${p.lossLimit} (1 to ${p.maxLots} lots)` : 'one lot each');

export function studyText(r) {
  if (!r) return '';
  const lines = [
    `Options study ${r.period.from} to ${r.period.to} (${r.period.days} trading days), ${sizingText(r.params)}, charges and slippage included, premiums estimated at ${Math.round(r.params.iv * 100)}% volatility.`,
    `Profit lock +${r.params.lockStart} keeps ${r.params.lockStart - r.params.lockGap}; stop is the chart level on a closed 1-minute candle; closed at 15:00; at most ${r.params.maxPerDay} trades a day; stops wider than ${r.params.maxStopAtr} ATR skipped.`,
    '',
  ];
  for (const t of r.techniques) {
    lines.push(`${t.label}: ${t.trades} trades, ${t.winRate ?? '-'}% win, net ${formatPnl(t.net)}, avg win ${formatPnl(t.avgWin)}, avg loss ${formatPnl(t.avgLoss)}, worst ${formatPnl(t.worst)}, best ${formatPnl(t.best)}, drawdown ${formatPnl(-t.maxDrawdown)}; calls ${formatPnl(t.bySide.CE.net)} (${t.bySide.CE.trades}), puts ${formatPnl(t.bySide.PE.net)} (${t.bySide.PE.trades}); ${t.signals} signals, ${t.skippedWide} skipped for a far stop.`);
  }
  if (r.botBreakdown) {
    lines.push('', 'Current bot, cut three ways:');
    for (const [title, rows] of [['By entry', r.botBreakdown.byTrigger], ['By score', r.botBreakdown.byScore], ['By side', r.botBreakdown.bySide]]) {
      for (const x of rows) lines.push(`${title} ${x.key}: ${x.trades} trades, ${x.winRate ?? '-'}% win, net ${formatPnl(x.net)}, avg win ${formatPnl(x.avgWin)}, avg loss ${formatPnl(x.avgLoss)}`);
    }
  }
  if (r.breadth?.length) {
    lines.push('', 'Breadth (share of the 50 stocks on one side, then what Nifty did in that direction):');
    for (const b of r.breadth) lines.push(`${b.share}%+ ${b.side}: ${b.episodes} times, next 30 min ${b.avg30 ?? '-'} pts (${b.hit30 ?? '-'}% right), next 60 min ${b.avg60 ?? '-'} pts (${b.hit60 ?? '-'}% right)`);
  }
  return lines.join('\n');
}

/** Hours with their trade counts and rupees, in time order: [{ hour, trades, net }]. */
export function hourRows(t) {
  return Object.entries(t?.byHour || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([h, v]) => ({ hour: hourWord(h), trades: v.trades, net: v.net }));
}
