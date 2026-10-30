import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { alreadySaved, canAdd, withFound } from '../../lib/autoFind.js';
import { Badge, Card } from '../ui.jsx';
import { Switch } from '../options/OptionsAutoCard.jsx';

const part = (p) => `${p.trades} trades · ${p.winRate ?? '–'}% win · ${formatPnl(p.net)}`;

/** The pair finder switch, and the check to start from ("Best three" or any one check). `kind` is 'options' or 'shares'. */
export function PairFinderControl({ on, setOn, first, setFirst, kind, finder, setFinder }) {
  const catalog = useApi('/combos/catalog', []);
  const own = useApi(kind === 'shares' ? '/auto' : '/options', []);
  const mine = own.data?.settings?.combos || [];
  const list = (catalog.data?.conditions || []).filter((c) => kind === 'shares' || c.needs !== 'news');
  const groups = catalog.data?.groups || [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] leading-snug text-muted">
          <b className="text-fg">Also find the best pair.</b> Takes one indicator, or one of your combinations, and tries every other check added to it, on the older two thirds of the days, and keeps only what also made money on the newer third. With one of your combinations it shows which extra check would have skipped its bad trades. Needs 10 days or more.
        </p>
        <Switch on={on} label="Find the best pair" onClick={() => setOn((v) => !v)} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] leading-snug text-muted">
          <b className="text-fg">Also run the combination finder.</b> Takes the 12 best single indicators and tries every pair and every group of three, kept only if it also made money on the newer days.
        </p>
        <Switch on={finder} label="Combination finder" onClick={() => setFinder((v) => !v)} />
      </div>
      {on && (
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>Start from</span>
          <select className="field !w-auto max-w-[60%] !px-2 !py-1.5 !text-xs" value={first} onChange={(e) => setFirst(e.target.value)} aria-label="Indicator to start the pair from">
            <option value="">The best three on their own</option>
            {mine.length > 0 && (
              <optgroup label="Add a check to one of my combinations">
                {mine.map((c) => (
                  <option key={c.id} value={`combo:${c.id}`}>{c.name}{c.on ? '' : ' (off)'}</option>
                ))}
              </optgroup>
            )}
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {list.filter((c) => c.group === g).map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/**
 * The best partner for an indicator: each starting check with the checks that did best beside it, learned on the older days and
 * checked on newer days it had not seen. "Add" saves a pair under My combinations, switched off. `endpoint` is '/options' or '/auto'.
 */
export function PairFinder({ pf, endpoint = '/options', callWord = 'Calls', putWord = 'Puts' }) {
  const own = useApi(endpoint, []);
  const [busy, setBusy] = useState(null);
  if (!pf) return null;
  const saved = own.data?.settings?.combos;

  async function add(f) {
    setBusy(f.conds.join('+'));
    try {
      await api(endpoint, { method: 'PUT', body: { combos: withFound(saved, f) } });
      own.reload?.();
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
          <Link2 className="h-4 w-4" /> {pf.addOn ? 'Best extra check' : 'Best pairs'}
        </h3>
        {pf.skipped ? (
          <p className="text-[11px] leading-snug text-muted">Not run: {pf.skipped}.</p>
        ) : (
          <p className="text-[11px] leading-snug text-muted">
            {pf.tried} pairs tried. Each was learned on the older {pf.trainDays} days and checked on the newer {pf.testDays} days it had not seen; only pairs that made money on both are shown (at least {pf.minTrain} and {pf.minTest} trades). "Against alone" is what the partner added over the first indicator (or your combination) by itself. Some will still be luck: add one switched off, watch it, and turn it on only when it keeps working.
          </p>
        )}
      </div>
      {(pf.anchors || []).map((a) => (
        <div key={a.key} className="space-y-1 rounded-lg bg-surface-2 p-2">
          <div className="flex items-start justify-between gap-2 text-xs">
            <span className="min-w-0 font-semibold">{a.label}</span>
            <span className={`num shrink-0 font-bold ${pnlClass(a.net)}`}>{formatPnl(a.net)}</span>
          </div>
          <p className="num text-[11px] text-muted">
            Alone: {part(a)} · older {formatPnl(a.train.net)} · newer {formatPnl(a.test.net)}
          </p>
          {a.found.length === 0 && <p className="text-[11px] text-muted">No partner made money on both the older and the newer days. That is a real answer: do not force a pair.</p>}
          <ul className="divide-y divide-line">
            {a.found.map((f) => (
              <li key={f.conds.join('+')} className="space-y-1 py-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">+ {f.added}</span>
                  <span className={`num shrink-0 text-sm font-bold ${pnlClass(f.net)}`}>{formatPnl(f.net)}</span>
                </div>
                <p className="num text-[11px] text-muted">
                  {f.trades} trades{pf.addOn && f.skipped > 0 ? ` (skips ${f.skipped})` : ''} · {f.winRate ?? '–'}% win · {formatPnl(f.lift)} against alone · {callWord} {formatPnl(f.calls.net)} ({f.calls.trades}) · {putWord} {formatPnl(f.puts.net)} ({f.puts.trades})
                </p>
                <p className="num text-[11px] text-muted">
                  Older days: {part(f.train)} · Newer days: {part(f.test)}
                </p>
                {alreadySaved(saved, f) ? (
                  <Badge tone="muted">Already in My combinations</Badge>
                ) : (
                  <button type="button" className="btn btn-sm" disabled={busy != null || !saved || !canAdd(saved)} onClick={() => add(f)}>
                    {canAdd(saved) ? 'Add to My combinations (off)' : 'My combinations is full (30)'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}
