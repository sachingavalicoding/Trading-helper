import { useState } from 'react';
import { toast } from 'sonner';
import { Wand2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { formatPnl, pnlClass } from '../lib/format.js';
import { canAdd, withFound } from '../lib/autoFind.js';
import { dayTotals, improveLine } from '../lib/patternReview.js';
import { Badge, Card } from './ui.jsx';

const MAX_ADD = 3;

/**
 * Review > Patterns: pick one of your combinations, see which indicator, added to it, would have skipped that day's bad entries (or added good
 * ones), tap up to three to draw the new combination and its entries on the chart, and save it (switched off) when it looks right.
 * `improve` is what the server worked out for the day; `trial` holds the chosen combination and checks.
 */
export function ImproveCombo({ combos, trial, setTrial, improve, newEntries, loading }) {
  const own = useApi('/options', []);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const saved = own.data?.settings?.combos;
  const rows = improve?.rows ?? [];
  const shown = all ? rows : rows.slice(0, 8);
  const toggle = (key) => setTrial({ ...trial, add: trial.add.includes(key) ? trial.add.filter((k) => k !== key) : [...trial.add, key].slice(-MAX_ADD) });
  const now = newEntries?.length ? dayTotals(newEntries) : null;

  async function save() {
    setBusy(true);
    try {
      const picked = rows.filter((x) => trial.add.includes(x.key));
      await api('/options', { method: 'PUT', body: { combos: withFound(saved, { conds: [...improve.conds, ...trial.add], labels: [improve.name, ...picked.map((x) => x.label)] }) } });
      own.reload?.();
      toast.success('Saved, switched off. Turn it on under Account > Entries.');
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2 border-accent2/40 p-3">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-accent2">
          <Wand2 className="h-4 w-4" /> Improve a combination
        </h3>
        <p className="text-[11px] leading-snug text-muted">Pick one of your combinations. Every indicator is tried added to it (all must hold) on this day, and ranked by what it would have saved: the entries it skips that lost money, less the winners it also skips. Tap up to three to draw the new combination on the chart.</p>
      </div>
      <label className="flex items-center justify-between gap-3 text-xs text-muted">
        <span>Combination</span>
        <select className="field !w-auto max-w-[65%] !px-2 !py-1.5 !text-xs" value={trial.id} onChange={(e) => setTrial({ id: e.target.value, add: [] })} aria-label="Combination to improve">
          <option value="">None</option>
          {combos.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.off ? ' (off)' : ''}</option>
          ))}
        </select>
      </label>
      {trial.id && loading && !improve && <p className="text-xs text-muted">Trying every indicator on this day…</p>}
      {improve?.missing && <p className="text-xs text-warn">That combination needs data this day does not have.</p>}
      {improve && !improve.missing && (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-surface-2 p-2">
              <div className="text-[10px] text-muted">{improve.name} now</div>
              <div className={`num text-sm font-bold ${pnlClass(improve.base.net)}`}>{formatPnl(improve.base.net)}</div>
              <div className="num text-[10px] text-muted">{improve.base.trades} entries, {improve.base.wins} won, {improve.base.trades - improve.base.wins} lost</div>
            </div>
            <div className="rounded-lg bg-surface-2 p-2">
              <div className="text-[10px] text-muted">{trial.add.length ? 'With your picks added' : 'With picks added'}</div>
              {now ? (
                <>
                  <div className={`num text-sm font-bold ${pnlClass(now.lock)}`}>{formatPnl(now.lock)}</div>
                  <div className="num text-[10px] text-muted">{now.traded} entries, {now.lockWins} won, {now.traded - now.lockWins} lost</div>
                </>
              ) : (
                <div className="text-[11px] text-muted">Tap an indicator below</div>
              )}
            </div>
          </div>
          {rows.length === 0 && <p className="text-xs text-muted">No single indicator changes this combination's entries on this day.</p>}
          <ul className="divide-y divide-line">
            {shown.map((x) => {
              const on = trial.add.includes(x.key);
              return (
                <li key={x.key}>
                  <button type="button" aria-pressed={on} onClick={() => toggle(x.key)} className={`flex w-full items-start justify-between gap-3 py-2 text-left text-xs ${on ? 'bg-surface-2' : ''}`}>
                    <span className="min-w-0">
                      <span className="block font-medium">+ {x.label} <Badge tone="muted">{x.group}</Badge></span>
                      <span className="num block text-[11px] text-muted">{improveLine(x)}</span>
                    </span>
                    <span className={`num shrink-0 font-semibold ${pnlClass(x.gain)}`}>{x.gain >= 0 ? 'saves ' : 'costs '}{formatPnl(Math.abs(x.gain))}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {rows.length > 8 && (
            <button type="button" className="btn btn-sm w-full" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
          {trial.add.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm" disabled={busy || !saved || !canAdd(saved)} onClick={save}>
                {canAdd(saved) ? 'Save as a new combination (off)' : 'My combinations is full (30)'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setTrial({ ...trial, add: [] })}>
                Clear picks
              </button>
            </div>
          )}
          <p className="text-[11px] leading-snug text-muted">One day proves little: an indicator that skipped today's losers may also skip tomorrow's winners. To check it over 30 days or more, use Account &gt; Studies &gt; Finder and start from this combination.</p>
        </>
      )}
    </Card>
  );
}
