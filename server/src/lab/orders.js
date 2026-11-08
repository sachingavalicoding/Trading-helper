import { normalizeCombo } from '../combos/combos.js';

// Order settings tried in the Combination Lab on one options combination, in place of its saved ones. Cleaned the same way as a save,
// so what the Lab tests is exactly what "Save to this combination" would keep.

const STOP_MODES = ['chart', 'cap', 'atr', 'fixed'];

/**
 * @param edit { side: 'CE' | 'PE' | null, stopMode: one of STOP_MODES or null (the shared stop), stopAtr, stopPoints, exits: { steps, trail, breakEven } or null (the shared exits) }
 */
export function withOrderOptions(combo, edit) {
  if (!edit) return combo;
  const raw = { ...combo };
  if ('side' in edit) raw.side = edit.side === 'CE' || edit.side === 'PE' ? edit.side : undefined;
  if ('stopMode' in edit) {
    if (STOP_MODES.includes(edit.stopMode)) Object.assign(raw, { stopMode: edit.stopMode, stopAtr: edit.stopAtr ?? combo.stopAtr ?? 2, stopPoints: edit.stopPoints ?? combo.stopPoints ?? 30 });
    else Object.assign(raw, { stopMode: undefined, stopAtr: undefined, stopPoints: undefined });
  }
  if ('exits' in edit) raw.exits = edit.exits ?? undefined;
  const out = normalizeCombo(raw);
  return out ? { ...out, id: combo.id } : combo;
}
