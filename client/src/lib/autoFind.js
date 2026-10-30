import { formatPnl } from './format.js';
import { fromSaved, toPayload } from './combos.js';

export const MAX_COMBOS = 30; // the most combinations the server keeps

const part = (p) => `${p.trades} trades, ${p.winRate ?? '-'}% win, ${formatPnl(p.net)}`;

/** The name a found combination is saved under: its checks, shortened. */
export const foundName = (f) => f.labels.map((l) => l.replace(/ \(.*\)$/, '')).join(' + ').slice(0, 60);

/** Whether the saved combinations already hold this exact set of checks. */
export const alreadySaved = (saved, f) => (saved || []).some((c) => c.conds.length === f.conds.length && f.conds.every((k) => c.conds.includes(k)));

/** The saved combinations plus the found one, switched off so nothing trades until the user looks at it. */
export function withFound(saved, f, stop = null) {
  const list = (saved || []).map((c, i) => toPayload(fromSaved(c), i));
  return [...list, { name: foundName(f), conds: f.conds, need: f.conds.length, window: 3, on: false, ...(stop ? { stopMode: stop.mode, stopAtr: stop.k, stopPoints: stop.points } : {}) }];
}

export const canAdd = (saved) => (saved || []).length < MAX_COMBOS;

/** The auto-find result as plain text, to paste into the chat. */
export function autoFindText(af) {
  if (!af) return '';
  if (af.skipped) return `Auto-find: ${af.skipped}.`;
  const lines = ['', `Auto-find (${af.tried} combinations tried; found on the older ${af.trainDays} days, checked on the newer ${af.testDays} days it had not seen${af.trainEnd ? `; one day: ${af.trainEnd}` : ''}):`];
  for (const b of af.baselines) lines.push(`Starting point ${b.label}: older ${part(b.train)}; newer ${part(b.test)}`);
  if (!af.found.length) lines.push('Nothing made money on both the older and the newer days.');
  for (const f of af.found) lines.push(`${f.labels.join(' + ')}: ${f.trades} trades, ${f.winRate ?? '-'}% win, ${formatPnl(f.net)}; older ${part(f.train)}; newer ${part(f.test)}`);
  return lines.join('\n');
}
