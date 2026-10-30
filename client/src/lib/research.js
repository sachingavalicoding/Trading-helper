import { formatPnl } from './format.js';

const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

export const GROUPS = [
  { value: 'stop', label: 'Stop amount' },
  { value: 'stoprule', label: 'Where the stop goes' },
  { value: 'ladder', label: 'Profit ladder' },
  { value: 'trail', label: 'Trail / break-even' },
];

/** What a tap on Apply would save, in words: "most loss ₹2,000, 6-step profit ladder, trailing stop 20 points". */
export function applyText(apply) {
  if (!apply) return '';
  const parts = [];
  const ruleWord = (r) => (r.mode === 'chart' ? 'at the chart level' : r.mode === 'cap' ? `at the chart level, pulled in to ${r.k} ATR` : r.mode === 'atr' ? `${r.k} ATR from the entry` : `${r.points} points from the entry`);
  if (apply.patternStop) parts.push(`stop ${ruleWord(apply.patternStop)} for every entry`);
  if (apply.comboStop) parts.push(`stop ${ruleWord(apply.comboStop)} for the combination "${apply.comboStop.name}" only`);
  if (apply.lossLimit != null) parts.push(`most one trade may lose ${rs(apply.lossLimit)}`);
  if (apply.steps) parts.push(`${apply.steps.length}-step profit ladder (${apply.steps.map((s) => `+${s.at} keeps ${s.keep}`).join(', ')})`);
  if (apply.breakEven) parts.push(`stop moves to your entry price after ${apply.breakEven} points`);
  if (apply.trail) parts.push(`trailing stop: ${apply.trail.points} points behind the best price, starting after ${apply.trail.start}`);
  return parts.join('; ');
}

/** The saves that apply an exit setting: the stop amount and the ladder go to the Account rules, the trailing stop to the options settings. */
export function applyRequests(apply, { combos = [] } = {}) {
  const out = [];
  if (apply?.patternStop) out.push({ path: '/options', body: { patternStopMode: apply.patternStop.mode, patternStopAtr: apply.patternStop.k, patternStopPoints: apply.patternStop.points } });
  if (apply?.comboStop) {
    const s = apply.comboStop;
    out.push({ path: '/options', body: { combos: combos.map((c) => (c.id === s.id ? { ...c, stopMode: s.mode, stopAtr: s.k, stopPoints: s.points } : c)) } });
  }
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

/** A stop or exit row that paid on both the older and the newer days (or any row when the run had no split). */
const steady = (split) => (x) => !split || (x.train?.net > 0 && x.test?.net > 0);

/** The stop and the profit setting that did best and held on the older and the newer days; null when none did. */
export function bestOf(r) {
  if (!r) return { stop: null, exit: null };
  const ok = steady(r.split);
  return { stop: r.bestStop ?? r.stops?.find(ok) ?? null, exit: r.bestExit ?? [...(r.exits || [])].filter(ok).sort((a, b) => b.net - a.net)[0] ?? null };
}

/** One combination's research as plain text: how far its winners went against it, the best stop and the best profit setting (the full table stays on screen). */
export function comboResearchText(r, label) {
  if (!r) return '';
  const part = (p) => (p ? `${p.trades} trades ${formatPnl(p.net)}` : '–');
  const row = (x) => `${x.label}${x.current ? ' (now)' : ''}: ${x.trades} trades, ${x.winRate ?? '-'}% win, ${formatPnl(x.net)}${r.split ? `; older ${part(x.train)}, newer ${part(x.test)}` : ''}`;
  const { stop, exit } = bestOf(r);
  const lines = [`  Stop and exits for ${label} (${r.signals} signals; your settings now: ${r.base.trades} trades, ${r.base.winRate ?? '-'}% win, ${formatPnl(r.base.net)}):`];
  if (r.adverse) lines.push(`  Its ${r.adverse.winners} winners went against it by at most ${rs(r.adverse.p50)} half the time, ${rs(r.adverse.p80)} 80% of the time, ${rs(r.adverse.p90)} 90% of the time and ${rs(r.adverse.max)} at the worst, per lot, before they won.`);
  lines.push(stop ? `  Best stop: ${row(stop)}` : '  No stop placement paid on both the older and the newer days.');
  if (exit) lines.push(`  Best profit setting: ${row(exit)}`);
  if (r.mix) lines.push(`  ${r.mix.label}: ${r.mix.text} Result: ${r.mix.trades} trades, ${formatPnl(r.mix.net)}${r.split ? `; older ${part(r.mix.train)}, newer ${part(r.mix.test)}` : ''}`);
  return lines.join('\n');
}

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
