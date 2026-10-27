import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatInt } from '../lib/format.js';

const rs = (v) => `₹${formatInt(v)}`;
import { nextRung, readLadder, sameLadder } from '../lib/ladder.js';

const asText = (rows) => rows.map((r) => ({ at: String(r.at), keep: String(r.keep) }));
const trim = (n) => String(Math.round(n * 1000) / 1000);

/**
 * The profit lock ladder: when the profit reaches a rung, the stop moves up to keep the second number, and then trails behind the
 * best profit by the difference. `unit` is 'rupee' (rupees per lot, for options) or 'percent' (of the money put in, for shares).
 */
export function LockLadderEditor({ title, hint, unit, rows, defaults, onSave, busy }) {
  const percent = unit === 'percent';
  const step = percent ? 0.05 : 50;
  const [draft, setDraft] = useState(() => asText(rows));
  useEffect(() => setDraft(asText(rows)), [rows]);

  const parsed = readLadder(draft);
  const changed = !sameLadder(draft, rows);
  const isDefault = sameLadder(rows, defaults);
  const set = (i, key, value) => setDraft((d) => d.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const unitLabel = percent ? '%' : '₹';

  async function save() {
    if (parsed.error) return toast.error(parsed.error);
    await onSave(parsed.rows);
  }

  return (
    <div className="col-span-2 space-y-2 rounded-xl border border-line p-2.5">
      <div>
        <div className="text-xs font-semibold text-fg">{title}</div>
        <p className="text-[11px] leading-snug text-muted">{hint}</p>
      </div>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-[10px] uppercase tracking-wide text-muted">
          <span>Profit reaches ({unitLabel})</span>
          <span>Stop keeps ({unitLabel})</span>
          <span className="w-7" />
        </div>
        {draft.map((r, i) => {
          const at = Number(r.at);
          const keep = Number(r.keep);
          const ok = at > 0 && keep > 0 && at > keep;
          return (
            <div key={i} className="space-y-0.5">
              <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                <input type="number" inputMode="decimal" step={step} min={step} value={r.at} onChange={(e) => set(i, 'at', e.target.value)} aria-label={`Rung ${i + 1} profit`} className="num w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent" />
                <input type="number" inputMode="decimal" step={step} min={step} value={r.keep} onChange={(e) => set(i, 'keep', e.target.value)} aria-label={`Rung ${i + 1} kept`} className="num w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent" />
                <button type="button" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} disabled={draft.length <= 1} aria-label={`Remove rung ${i + 1}`} className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {ok && (
                <p className="num text-[10px] text-muted">
                  {percent
                    ? `On ₹1 lakh: +${rs(at * 1000)} keeps ${rs(keep * 1000)}, then trails ${trim(at - keep)}% (${rs((at - keep) * 1000)}) behind the best profit`
                    : `+${rs(at)} keeps ${rs(keep)}, then trails ${rs(at - keep)} behind the best profit`}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {parsed.error && changed && <p className="text-[11px] text-down">{parsed.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setDraft((d) => (d.length < 8 ? [...d, nextRung(d, step)] : d))} disabled={draft.length >= 8} className="btn btn-secondary btn-sm">
          <Plus className="h-3.5 w-3.5" /> Add rung
        </button>
        <button type="button" onClick={save} disabled={busy || !changed || Boolean(parsed.error)} className="btn btn-primary btn-sm">
          Save ladder
        </button>
        <button type="button" onClick={() => onSave([])} disabled={busy || isDefault} className="btn btn-ghost btn-sm">
          Use built-in
        </button>
      </div>
    </div>
  );
}
