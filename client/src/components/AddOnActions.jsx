import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { addChecks, canAdd, changesCombo, withCopy, withUpdated } from '../lib/autoFind.js';
import { fromSaved, ruleText, toPayload } from '../lib/combos.js';
import { useCatalog } from './CheckInfo.jsx';

/**
 * The two buttons under picked add-on indicators: "Update <combination>" changes the saved combination in place (after a second tap that
 * says what it becomes), "Save as new combination" keeps it as it is and saves a copy with the add-ons, switched off.
 * @param saved     the saved combinations (from GET /options or /auto)
 * @param comboId   the one the add-ons were tried on
 * @param add       the picked check keys; labels their names
 * @param all       true when the add-ons were tested with every check a must (the Finder), so the update makes the rule "all"
 */
export function AddOnActions({ saved, comboId, add, labels, endpoint = '/options', all = false, onSaved, onClear }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const catalog = useCatalog();
  const combo = (saved || []).find((c) => c.id === comboId);
  if (!combo || !add.length) return null;
  const label = (k) => catalog?.conditions.find((c) => c.key === k)?.label ?? k;
  const after = addChecks(toPayload(fromSaved(combo)), add, { all });
  const changes = changesCombo(combo, add);

  async function put(list, done) {
    setBusy(true);
    try {
      await api(endpoint, { method: 'PUT', body: { combos: list } });
      toast.success(done);
      setConfirm(false);
      onSaved?.();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {confirm ? (
        <div className="space-y-2 rounded-lg border border-accent/50 bg-surface-2 p-2 text-xs leading-snug">
          <p>
            <b>Update {combo.name}?</b> {combo.on ? 'It is switched on, so the bot trades the new rule from the next bar. ' : 'It is switched off, so nothing trades until you turn it on. '}
            It becomes: {ruleText({ ...after, need: after.need >= after.conds.length ? 0 : after.need })}: {after.conds.map(label).join(' + ')}
            {after.also?.length ? `; and must also hold: ${after.also.map(label).join(' + ')}` : ''}. Its stop and exits stay as they are.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => put(withUpdated(saved, comboId, add, { all }), `${combo.name} updated.`)}>
              Yes, update it
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn btn-sm" disabled={busy || !changes} onClick={() => setConfirm(true)}>
            Update {combo.name.length > 18 ? 'this combination' : combo.name}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy || !changes || !canAdd(saved)} onClick={() => put(withCopy(saved, comboId, add, labels, { all }), 'Saved as a new combination, switched off. Turn it on under Combos.')}>
            {canAdd(saved) ? 'Save as new combination' : 'My combinations is full (30)'}
          </button>
        </div>
      )}
      {onClear && !confirm && (
        <button type="button" className="btn btn-sm w-full" onClick={onClear}>
          Clear picks
        </button>
      )}
      {!changes && <p className="text-[11px] text-muted">These checks are already in {combo.name}.</p>}
    </div>
  );
}
