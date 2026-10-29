import { formatPnl } from './format.js';

const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

export const GROUPS = [
  { value: 'stop', label: 'Stop amount' },
  { value: 'ladder', label: 'Profit ladder' },
  { value: 'trail', label: 'Trail / break-even' },
];

/** What a tap on Apply would save, in words: "most loss ₹2,000, 6-step profit ladder, trailing stop 20 points". */
export function applyText(apply) {
  if (!apply) return '';
  const parts = [];
  if (apply.lossLimit != null) parts.push(`most one trade may lose ${rs(apply.lossLimit)}`);
  if (apply.steps) parts.push(`${apply.steps.length}-step profit ladder (${apply.steps.map((s) => `+${s.at} keeps ${s.keep}`).join(', ')})`);
  if (apply.breakEven) parts.push(`stop moves to your entry price after ${apply.breakEven} points`);
  if (apply.trail) parts.push(`trailing stop: ${apply.trail.points} points behind the best price, starting after ${apply.trail.start}`);
  return parts.join('; ');
}

/** The saves that apply an exit setting: the stop amount and the ladder go to the Account rules, the trailing stop to the options settings. */
export function applyRequests(apply) {
  const out = [];
  const options = {};
  if (apply?.lossLimit != null) options.stopLoss = apply.lossLimit;
  if (apply?.steps) options.steps = apply.steps;
  if (Object.keys(options).length) out.push({ path: '/trade-defaults', body: { options } });
  const opt = {};
  if (apply?.trail) Object.assign(opt, { trailMode: 'points', trailPoints: apply.trail.points, trailStart: apply.trail.start });
  if (apply?.breakEven) opt.breakEvenPoints = apply.breakEven;
  if (Object.keys(opt).length) out.push({ path: '/options', body: opt });
  return out;
}

const part = (p) => (p ? `${p.trades} trades ${formatPnl(p.net)}` : '–');

/** The research as plain text, to paste into the chat. */
export function researchText(r) {
  if (!r) return '';
  if (r.skipped) return `Research: ${r.skipped}.`;
  const lines = ['', `Research on ${r.entries} (${r.signals} signals): each row changes only one thing from your settings.`];
  lines.push(`Your settings now: ${r.base.trades} trades, ${r.base.winRate ?? '-'}% win, ${formatPnl(r.base.net)}, drawdown ${formatPnl(-r.base.maxDrawdown)}${r.split ? `; older days ${part(r.base.train)}, newer days ${part(r.base.test)}` : ''}`);
  for (const g of GROUPS) {
    lines.push(`${g.label}:`);
    for (const x of r.rows.filter((row) => row.group === g.value)) {
      lines.push(`  ${x.label}${x.current ? ' (yours)' : ''}: ${x.trades} trades, ${x.winRate ?? '-'}% win, ${formatPnl(x.net)}, drawdown ${formatPnl(-x.maxDrawdown)}, ${x.verdict}${r.split ? `; older ${part(x.train)}, newer ${part(x.test)}` : ''}`);
    }
  }
  if (r.mix) lines.push(`${r.mix.label}: ${r.mix.text} Result: ${r.mix.trades} trades, ${formatPnl(r.mix.net)}${r.split ? `; older ${part(r.mix.train)}, newer ${part(r.mix.test)}` : ''}`);
  return lines.join('\n');
}
