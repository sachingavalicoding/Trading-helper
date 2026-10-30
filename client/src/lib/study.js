import { formatPnl } from './format.js';
import { DEFAULT_EXIT_MIN, timeText } from './ladder.js';
import { indicatorsText } from './combos.js';
import { breakEvenText, stopRuleText, trailText } from './stops.js';
import { autoFindText } from './autoFind.js';
import { researchText } from './research.js';
import { pairsText } from './pairs.js';

export const EXIT_WORD = { STOP: 'Stop hit', LOCK: 'Profit lock', EOD: 'Closed on time', TARGET: 'Target hit', TRAIL: 'Trailing stop', BREAKEVEN: 'Break-even stop' };
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

/** How many lots each trade used, in words. */
export const sizingText = (p) => {
  if (p.fixedLots > 0) return `${p.fixedLots} lot${p.fixedLots > 1 ? 's' : ''} each, fewer if the loss at the stop would pass ₹${p.lossLimit}`;
  return p.lossLimit > 0 ? `lots sized so the loss at the stop stays within ₹${p.lossLimit} (1 to ${p.maxLots} lots)` : 'one lot each';
};

/** The exit rule a study used, in words. */
export const exitText = (p) => (p.exit === 'target' ? `No profit lock: sold when the profit reaches +₹${p.target} a lot, or at the stop` : (p.steps?.length > 1 ? `Profit lock ladder: ${p.steps.map((r) => `+${r.at} keeps ${r.keep}`).join(', ')}` : p.steps?.length === 0 ? 'No profit lock' : `Profit lock +${p.lockStart} keeps ${p.lockStart - p.lockGap}`));

/** The whole study as plain text, to paste into the chat. */
export function studyText(r) {
  if (!r) return '';
  const lines = [
    `${r.params.index === 'SENSEX' ? 'Sensex options' : 'Options'} study ${r.period.from} to ${r.period.to} (${r.period.days} trading days), ${sizingText(r.params)}, charges and slippage included, premiums estimated at ${Math.round(r.params.iv * 100)}% volatility.`,
    `${exitText(r.params)}; ${stopRuleText(r.params.stopRule)}${r.params.trail ? `; ${trailText(r.params.trail)}` : ''}${r.params.breakEven ? `; ${breakEvenText(r.params.breakEven)}` : ''}; closed at ${timeText(r.params.exitMin ?? DEFAULT_EXIT_MIN)}; at most ${r.params.maxPerDay} trades a day; stops wider than ${r.params.maxStopAtr} ATR skipped.`,
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
  for (const s of r.combosSkipped || []) lines.push('', `${s.name} was not tested: ${s.reason}.`);
  return [...lines, indicatorsText(r.indicators), autoFindText(r.autoFound), pairsText(r.pairs), autoFindText(r.comboFound), researchText(r.research)].join('\n').trimEnd();
}

/** Hours with their trade counts and rupees, in time order: [{ hour, trades, net }]. */
export function hourRows(t) {
  return Object.entries(t?.byHour || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([h, v]) => ({ hour: hourWord(h), trades: v.trades, net: v.net }));
}

/** The exit rule a shares study used, in words. Results saved before the exit choice have no `exit` and used the old percent ladder. */
export function sharesExitText(p) {
  if (p.exit === 'target') return `No profit lock: sold when a trade's profit reaches +₹${p.target}, or at the stop`;
  if (p.exit !== 'lock') return 'Exits: an older percent ladder, so the rupees are a guide';
  if (!p.steps?.length) return 'No profit lock';
  return `Profit ladder: ${p.steps.map((r) => `+₹${r.at} keeps ₹${r.keep}`).join(', ')}`;
}

/** The shares study as plain text, to paste into the chat. */
export function sharesText(r) {
  if (!r) return '';
  const o = r.overall;
  const line = (x) => `${x.key}: ${x.trades} trades, ${x.winRate ?? '-'}% win, net ${formatPnl(x.totalNet)}, avg win ${formatPnl(x.avgWin)}, avg loss ${formatPnl(x.avgLoss)}, profit factor ${x.profitFactor ?? '-'}`;
  const lines = [
    `Shares study, last ${r.period.days} trading days, ${r.period.stocks} stocks, each trade sized to risk ₹${r.params.riskAmount} at its stop, charges and ${r.params.slippagePct}% slippage included. ${sharesExitText(r.params)}; the stop is the scanner's chart stop; closed at ${timeText(r.params.exitMin ?? DEFAULT_EXIT_MIN)}.`,
    `All: ${o.trades} trades, ${o.winRate ?? '-'}% win, net ${formatPnl(o.totalNet)}, charges ${formatPnl(o.totalCharges)}, drawdown ${formatPnl(-o.maxDrawdown)}.`,
    '',
    'By setup:',
    ...r.bySetup.map(line),
    '',
    'By side:',
    ...r.bySide.map(line),
    '',
    'By hour:',
    ...r.byHour.map(line),
    '',
    'By how it ended:',
    ...r.byExit.map(line),
    '',
    'First target (share of ideas that ran this many risks before the stop, average result in risks):',
    ...r.firstTarget.map((t) => `${t.target}R: reached ${t.hitRate ?? '-'}%, expectancy ${t.expectancyR ?? '-'}R`),
  ];
  if (r.combos?.length) {
    lines.push('', 'My combinations:');
    for (const x of r.combos) lines.push(`${line({ ...x, key: x.label.replace('My combination: ', '') })}; buys ${formatPnl(x.buys.net)} (${x.buys.trades}), sells ${formatPnl(x.sells.net)} (${x.sells.trades}); halves ${formatPnl(x.halves[0])} / ${formatPnl(x.halves[1])}; ${x.text}`);
  }
  for (const s of r.combosSkipped || []) lines.push('', `${s.name} was not tested: ${s.reason}.`);
  return [...lines, indicatorsText(r.indicators, 'Indicators on their own (buys and sells)'), pairsText(r.pairs, 'Buys', 'Sells'), autoFindText(r.comboFound)].join('\n').trimEnd();
}
