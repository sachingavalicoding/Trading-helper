import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { alreadySaved, canAdd, withFound } from '../../lib/autoFind.js';
import { Badge, Card } from '../ui.jsx';

const part = (p) => `${p.trades} trades · ${p.winRate ?? '–'}% win · ${formatPnl(p.net)}`;

/**
 * Combinations the study found by itself: learned on the older days, then checked on newer days it had not seen.
 * "Add" saves one under Account > Entries > My combinations, switched off, so nothing trades until you turn it on.
 */
export function AutoFound({ af }) {
  const opts = useApi('/options', []);
  const [busy, setBusy] = useState(null);
  if (!af) return null;
  const saved = opts.data?.settings?.combos;

  async function add(f, i) {
    setBusy(i);
    try {
      await api('/options', { method: 'PUT', body: { combos: withFound(saved, f) } });
      opts.reload?.();
      toast.success('Added, switched off. Turn it on under Account > Entries.');
    } catch (e) {
      toast.error(e.message || 'Could not add');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-2 border-accent2/40 p-3">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-accent2">
          <Sparkles className="h-4 w-4" /> Found for you
        </h3>
        {af.skipped ? (
          <p className="text-[11px] leading-snug text-muted">Not run: {af.skipped}.</p>
        ) : (
          <p className="text-[11px] leading-snug text-muted">
            {af.tried} combinations tried. Each was learned on the older {af.trainDays} days and then checked on the newer {af.testDays} days it had not seen; only the ones that made money on both are shown (at least {af.minTrain} and {af.minTest} trades). With this many tries some will still be luck, so add one switched off, watch it in Review, and switch it on only when it keeps working.
          </p>
        )}
      </div>
      {!af.skipped && (
        <ul className="space-y-1 text-[11px] text-muted">
          {af.baselines.map((b) => (
            <li key={b.label} className="num">
              Starting point <b className="text-fg">{b.label}</b>: older {formatPnl(b.train.net)} ({b.train.trades}), newer {formatPnl(b.test.net)} ({b.test.trades})
            </li>
          ))}
        </ul>
      )}
      {!af.skipped && af.found.length === 0 && <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">Nothing made money on both the older and the newer days. That is a real answer: do not force a combination.</p>}
      <ul className="divide-y divide-line">
        {(af.found || []).map((f, i) => {
          const have = alreadySaved(saved, f);
          return (
            <li key={f.conds.join('+')} className="space-y-1 py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 font-semibold">{f.labels.join(' + ')}</span>
                <span className={`num shrink-0 text-sm font-bold ${pnlClass(f.net)}`}>{formatPnl(f.net)}</span>
              </div>
              <p className="num text-[11px] text-muted">
                {f.trades} trades · {f.winRate ?? '–'}% win · Calls {formatPnl(f.calls.net)} ({f.calls.trades}) · Puts {formatPnl(f.puts.net)} ({f.puts.trades})
              </p>
              <p className="num text-[11px] text-muted">
                Older days: {part(f.train)} · Newer days: {part(f.test)}
              </p>
              {have ? (
                <Badge tone="muted">Already in My combinations</Badge>
              ) : (
                <button type="button" className="btn btn-sm" disabled={busy != null || !saved || !canAdd(saved)} onClick={() => add(f, i)}>
                  {canAdd(saved) ? 'Add to My combinations (off)' : 'My combinations is full (12)'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
