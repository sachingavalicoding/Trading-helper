import { formatPnl } from './format.js';

// Helpers for the combination builder (Account > Entries) and the indicator ranking in the studies.

export const MAX_CHECKS = 20;
export const VERDICT = {
  Keep: { tone: 'up', text: 'Keep', hint: 'Made money, and in both halves of the period' },
  Unsteady: { tone: 'warn', text: 'Unsteady', hint: 'Made money overall but lost in one half, so it may suit only one kind of market' },
  Drop: { tone: 'down', text: 'Drop', hint: 'Lost money on its own' },
  'Too few': { tone: 'muted', text: 'Too few', hint: 'Under 15 trades, so it says nothing' },
};
const NEEDS_WORD = { flow: 'volume', breadth: '50-stock breadth', news: 'news' };

export const blankCombo = () => ({ name: '', conds: [], need: 0, window: 3, on: true });

/** The combination with `key` added, or taken off when it is already in; at most MAX_CHECKS. `need` follows the count when it was "all". */
export function toggleCheck(combo, key) {
  const has = combo.conds.includes(key);
  if (!has && combo.conds.length >= MAX_CHECKS) return combo;
  const conds = has ? combo.conds.filter((k) => k !== key) : [...combo.conds, key];
  const all = !combo.need || combo.need >= combo.conds.length;
  return { ...combo, conds, need: all ? 0 : Math.min(combo.need, conds.length) };
}

/** `need` 0 means every check must hold. */
export const needOf = (combo) => (combo.need > 0 && combo.need < combo.conds.length ? combo.need : combo.conds.length);

/** The rule in words: "All 3 must hold" or "Any 2 of 4 must hold". */
export function ruleText(combo) {
  const n = combo.conds.length;
  const need = needOf(combo);
  if (!n) return 'No checks picked yet';
  return need >= n ? (n === 1 ? 'The check must hold' : `All ${n} must hold together`) : `Any ${need} of ${n} must hold together`;
}

/** A combination ready to send: ids and names filled, `need` 0 turned into the count. */
export function toPayload(combo, index = 0) {
  const own = combo.stopMode ? { stopMode: combo.stopMode, stopAtr: combo.stopAtr || 2, stopPoints: combo.stopPoints || 30 } : {};
  const exits = combo.exits && Object.keys(combo.exits).length ? { exits: combo.exits } : {};
  const order = combo.order && Object.values(combo.order).some((v) => Number(v) > 0) ? { order: Object.fromEntries(Object.entries(combo.order).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)])) } : {};
  return { id: combo.id, name: combo.name.trim() || `Combination ${index + 1}`, conds: combo.conds, ...(combo.also?.length ? { also: combo.also } : {}), need: needOf(combo), window: combo.window || 3, on: combo.on !== false, ...(combo.side === 'CE' || combo.side === 'PE' ? { side: combo.side } : {}), ...(combo.on === false && combo.benchedOn ? { benchedOn: combo.benchedOn } : {}), ...own, ...exits, ...order };
}

/** A profit ladder of 8 rows 500 apart: lock `gap` points less than the gain reached. */
export function roomSteps(start = 1000, gap = 500) {
  return Array.from({ length: 8 }, (_, i) => { const at = start + i * 500; return { at, keep: Math.max(1, at - gap) }; });
}

/** A combination's own exits in words, or null when it uses the Account ones. */
export function exitsText(c) {
  const e = c?.exits;
  if (!e) return null;
  const out = [];
  if ('steps' in e) out.push(e.steps?.length ? `profit ladder from ${e.steps[0].at} (${e.steps.length} steps)` : 'no profit ladder');
  if ('trail' in e) out.push(e.trail ? `trail ${e.trail.points} points` : 'no trail');
  if ('breakEven' in e) out.push(e.breakEven ? `break-even at ${e.breakEven} points` : 'no break-even');
  return out.length ? out.join(', ') : null;
}

/** Load a saved combination into the editor: "all" is shown as need 0. */
export const STOP_MODES = [
  { value: '', label: 'Shared stop' },
  { value: 'chart', label: 'Chart level' },
  { value: 'cap', label: 'Pulled in' },
  { value: 'atr', label: 'ATR' },
  { value: 'fixed', label: 'Points' },
];

/** A combination's own stop in words, or null when it uses the shared one. */
export function stopWord(c) {
  if (!c?.stopMode) return null;
  if (c.stopMode === 'chart') return 'stop at the chart level';
  if (c.stopMode === 'cap') return `stop at the chart level, pulled in to ${c.stopAtr ?? 2} ATR`;
  if (c.stopMode === 'atr') return `stop ${c.stopAtr ?? 2} ATR from the entry`;
  return `stop ${c.stopPoints ?? 30} points from the entry`;
}

/** The side a combination trades, in words: calls only, puts only, or both. */
export const sideWord = (c) => (c?.side === 'CE' ? 'calls only' : c?.side === 'PE' ? 'puts only' : 'calls and puts');

/** The index a combination trades, in words. */

export const fromSaved = (c) => ({ ...c, need: c.need >= c.conds.length ? 0 : c.need });

/**
 * The checks to pick from, grouped, narrowed by a search and what the bot can use.
 * @param verdicts  { key: 'Keep' | 'Unsteady' | 'Drop' | 'Too few' } from the latest study
 * @param usable    (condition) => boolean: false hides checks that cannot work for this bot (news for options)
 */
export function pickList(catalog, { query = '', verdicts = {}, hideDropped = true, usable = () => true } = {}) {
  const q = query.trim().toLowerCase();
  const rows = catalog.conditions
    .filter((c) => usable(c))
    .filter((c) => !q || `${c.label} ${c.text} ${c.group}`.toLowerCase().includes(q))
    .map((c) => ({ ...c, verdict: verdicts[c.key] || null }));
  const dropped = rows.filter((c) => c.verdict === 'Drop').length;
  const shown = hideDropped && !q ? rows.filter((c) => c.verdict !== 'Drop') : rows;
  const groups = catalog.groups.map((g) => ({ group: g, items: shown.filter((c) => c.group === g) })).filter((g) => g.items.length);
  return { groups, dropped };
}

/** { key: verdict } from a study result's indicator rows. */
export const verdictMap = (rows) => Object.fromEntries((rows || []).map((r) => [r.key, r.verdict]));

export const needsText = (c) => (c.needs ? `Needs ${NEEDS_WORD[c.needs] || c.needs}` : null);

/** The indicator ranking as plain text, to paste into the chat. */
export function indicatorsText(rows, title = 'Indicators on their own') {
  if (!rows?.length) return '';
  const lines = ['', `${title} (each time the check turns true; verdict Keep needs a profit in both halves of the period):`];
  for (const x of rows) lines.push(`${x.label} [${x.group}]: ${x.verdict}, ${x.trades} trades, ${x.winRate ?? '-'}% win, net ${formatPnl(x.net)}, halves ${formatPnl(x.halves[0])} / ${formatPnl(x.halves[1])}`);
  return lines.join('\n');
}

const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The side a share combination trades, in words. */
export const shareSideWord = (c) => (c?.side === 'CE' ? 'buys only' : c?.side === 'PE' ? 'short sales only' : 'buys and short sales');

/** A share combination's own order settings in words (risk, money, stop, target or ladder, exit time), or null when it uses the Account ones. */
export function orderText(c) {
  const o = c?.order || {};
  const out = [];
  if (o.risk > 0) out.push(`risk ${rupees(o.risk)} a trade`);
  if (o.maxAmount > 0) out.push(`at most ${rupees(o.maxAmount)} in a trade`);
  if (o.stopPct > 0) out.push(`stop ${o.stopPct}% from the entry`);
  if (o.target > 0) out.push(`sell at +${rupees(o.target)}`);
  else if (c?.exits && Array.isArray(c.exits.steps)) out.push(c.exits.steps.length ? `own profit lock from +${rupees(c.exits.steps[0].at)}` : 'no profit lock');
  if (o.exitMin > 0) out.push(`close at ${clock(o.exitMin)}`);
  return out.length ? out.join(', ') : null;
}
