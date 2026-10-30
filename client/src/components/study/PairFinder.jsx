import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { alreadySaved, canAdd, withFound } from '../../lib/autoFind.js';
import { skipsText } from '../../lib/pairs.js';
import { bestOf } from '../../lib/research.js';
import { Badge, Card } from '../ui.jsx';
import { ComboResearch } from './ComboResearch.jsx';
import { Switch } from '../options/OptionsAutoCard.jsx';

const part = (p) => `${p.trades} trades · ${p.winRate ?? '–'}% win · ${formatPnl(p.net)}`;

/** The check or saved combination a finder starts from. `kind` is 'options' or 'shares'. */
export function StartFromSelect({ kind, value, onChange }) {
  const catalog = useApi('/combos/catalog', []);
  const own = useApi(kind === 'shares' ? '/auto' : '/options', []);
  const mine = own.data?.settings?.combos || [];
  const list = (catalog.data?.conditions || []).filter((c) => kind === 'shares' || c.needs !== 'news');
  const groups = catalog.data?.groups || [];
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-muted">
      <span>Start from</span>
      <select className="field !w-auto max-w-[60%] !px-2 !py-1.5 !text-xs" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Indicator or combination to start from">
        <option value="">The best three on their own</option>
        {mine.length > 0 && (
          <optgroup label="Add checks to my combinations">
            <option value="combo:*">All my combinations that are on (up to 6)</option>
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
  );
}

/** The pair finder switch, and the check to start from ("Best three" or any one check). `kind` is 'options' or 'shares'. */
export function PairFinderControl({ on, setOn, first, setFirst, kind, finder, setFinder }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] leading-snug text-muted">
          <b className="text-fg">Find the best pair.</b> Takes one indicator, or your combinations, and tries every other check added to it, then the best two and three together, on the older two thirds of the days, and keeps only what also made money on the newer third (up to 10 results each). It also researches the best stop and profit settings for each. With it on, only the finder runs, not the normal study, and it takes longer. Needs 10 days or more.
        </p>
        <Switch on={on} label="Find the best pair" onClick={() => setOn((v) => !v)} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] leading-snug text-muted">
          <b className="text-fg">Combination finder.</b> Takes the 12 best single indicators and tries every pair and every group of three, kept only if it also made money on the newer days.
        </p>
        <Switch on={finder} label="Combination finder" onClick={() => setFinder((v) => !v)} />
      </div>
      {on && <StartFromSelect kind={kind} value={first} onChange={setFirst} />}
    </div>
  );
}

/**
 * The best partner for an indicator: each starting check with the checks that did best beside it, learned on the older days and
 * checked on newer days it had not seen. "Add" saves a pair under My combinations, switched off. `endpoint` is '/options' or '/auto'.
 */
export function PairFinder({ pf, endpoint = '/options', callWord = 'Calls', putWord = 'Puts', onApplied }) {
  const own = useApi(endpoint, []);
  const [busy, setBusy] = useState(null);
  if (!pf) return null;
  const saved = own.data?.settings?.combos;

  async function add(f, stop = null) {
    setBusy(f.conds.join('+'));
    try {
      await api(endpoint, { method: 'PUT', body: { combos: withFound(saved, f, stop) } });
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
          {a.research && <ComboResearch r={a.research} own={a.key.startsWith('combo:')} onApplied={onApplied} />}
          <ul className="divide-y divide-line">
            {a.found.map((f) => (
              <li key={f.conds.join('+')} className="space-y-1 py-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">+ {[].concat(f.added).join(' + ')} <Badge tone="muted">{f.depth > 1 ? `${f.depth} added` : '1 added'}</Badge></span>
                  <span className={`num shrink-0 text-sm font-bold ${pnlClass(f.net)}`}>{formatPnl(f.net)}</span>
                </div>
                <p className="num text-[11px] text-muted">
                  {f.trades} trades · {f.winRate ?? '–'}% win{a.winRate != null ? ` (alone ${a.winRate}%)` : ''} · {formatPnl(f.lift)} against alone · {callWord} {formatPnl(f.calls.net)} ({f.calls.trades}) · {putWord} {formatPnl(f.puts.net)} ({f.puts.trades})
                </p>
                {skipsText(f) && <p className="num text-[11px] text-muted">It {skipsText(f)}.</p>}
                <p className="num text-[11px] text-muted">
                  Older days: {part(f.train)} · Newer days: {part(f.test)}
                </p>
                {alreadySaved(saved, f) ? (
                  <Badge tone="muted">Already in My combinations</Badge>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-sm" disabled={busy != null || !saved || !canAdd(saved)} onClick={() => add(f)}>
                      {canAdd(saved) ? 'Add to My combinations (off)' : 'My combinations is full (30)'}
                    </button>
                    {endpoint === '/options' && (f.research?.mix?.apply?.comboStop ?? bestOf(f.research).stop?.apply?.comboStop) && canAdd(saved) && (
                      <button type="button" className="btn btn-sm" disabled={busy != null || !saved} onClick={() => add(f, f.research.mix?.apply?.comboStop ?? bestOf(f.research).stop.apply.comboStop)}>
                        Add with its best stop
                      </button>
                    )}
                  </div>
                )}
                {f.research && <ComboResearch r={f.research} own={false} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}
