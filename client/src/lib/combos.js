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
  return { id: combo.id, name: combo.name.trim() || `Combination ${index + 1}`, conds: combo.conds, need: needOf(combo), window: combo.window || 3, on: combo.on !== false };
}

/** Load a saved combination into the editor: "all" is shown as need 0. */
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
