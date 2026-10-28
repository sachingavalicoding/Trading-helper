import { useMemo, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { MAX_CHECKS, VERDICT, blankCombo, fromSaved, needOf, needsText, pickList, ruleText, toPayload, toggleCheck, verdictMap } from '../../lib/combos.js';
import { Badge, Card, Segmented, Skeleton } from '../ui.jsx';
import { Switch } from '../options/OptionsAutoCard.jsx';

const KIND_WORD = { state: 'Now', event: 'Event' };

function VerdictBadge({ verdict }) {
  if (!verdict) return null;
  const v = VERDICT[verdict];
  return (
    <span title={v.hint}>
      <Badge tone={v.tone}>{v.text}</Badge>
    </span>
  );
}

function Editor({ catalog, kind, verdicts, initial, onSave, onCancel, busy }) {
  const [combo, setCombo] = useState(initial);
  const [query, setQuery] = useState('');
  const [showDropped, setShowDropped] = useState(false);
  const byKey = useMemo(() => new Map(catalog.conditions.map((c) => [c.key, c])), [catalog]);
  const list = useMemo(() => pickList(catalog, { query, verdicts, hideDropped: !showDropped, usable: (c) => kind === 'shares' || c.needs !== 'news' }), [catalog, query, verdicts, showDropped, kind]);
  const n = combo.conds.length;
  const need = needOf(combo);
  const hasEvent = combo.conds.some((k) => byKey.get(k)?.kind === 'event');
  const liveOnly = combo.conds.some((k) => byKey.get(k)?.needs === 'news');
  const set = (patch) => setCombo((c) => ({ ...c, ...patch }));

  return (
    <Card className="space-y-3 border-accent p-3">
      <input className="field" placeholder="Name, for example Trend + VWAP" value={combo.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} aria-label="Combination name" />

      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
          <span>
            Checks picked ({n} of {MAX_CHECKS})
          </span>
          <span>{ruleText(combo)}</span>
        </div>
        {n === 0 && <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">Tap checks below to add them.</p>}
        <div className="flex flex-wrap gap-1.5">
          {combo.conds.map((k) => (
            <button key={k} type="button" onClick={() => setCombo((c) => toggleCheck(c, k))} className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-[11px] font-semibold text-on-accent" aria-label={`Remove ${byKey.get(k)?.label || k}`}>
              {byKey.get(k)?.label || k} <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      </div>

      {n > 1 && (
        <div className="space-y-1.5">
          <Segmented className="w-full" size="sm" value={need >= n ? 'all' : 'some'} onChange={(v) => set({ need: v === 'all' ? 0 : Math.max(1, n - 1) })} options={[{ value: 'all', label: `All ${n} together` }, { value: 'some', label: 'Any … of them' }]} />
          {need < n && (
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span>At least this many must hold</span>
              <span className="flex items-center gap-2">
                <button type="button" className="btn btn-sm" onClick={() => set({ need: Math.max(1, need - 1) })} aria-label="Fewer">
                  −
                </button>
                <b className="num w-4 text-center text-fg">{need}</b>
                <button type="button" className="btn btn-sm" onClick={() => set({ need: Math.min(n - 1, need + 1) })} aria-label="More">
                  +
                </button>
              </span>
            </div>
          )}
        </div>
      )}
      {hasEvent && (
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>An event (a cross, a break, a pattern) counts for</span>
          <select className="field num !w-24 !px-2 !py-1.5 !text-sm" value={combo.window} onChange={(e) => set({ window: Number(e.target.value) })} aria-label="Bars an event counts for">
            {[1, 2, 3, 4, 5, 6].map((w) => (
              <option key={w} value={w}>
                {w} bar{w > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {liveOnly && <p className="rounded-lg bg-surface-2 p-2 text-[11px] leading-snug text-muted">News is live only: past headlines are not kept, so a study cannot test a combination with a news check.</p>}

      <div className="space-y-2">
        <input className="field" type="search" placeholder="Search the checks (RSI, VWAP, breadth, engulfing…)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the checks" />
        {list.dropped > 0 && !query && (
          <button type="button" className="text-[11px] text-accent underline" onClick={() => setShowDropped((s) => !s)}>
            {showDropped ? 'Hide' : 'Show'} the {list.dropped} check{list.dropped > 1 ? 's' : ''} the last study marked Drop
          </button>
        )}
        {list.groups.map((g) => (
          <details key={g.group} open={Boolean(query) || undefined} className="rounded-xl border border-line">
            <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs font-semibold">
              {g.group}
              <span className="text-muted">{g.items.length}</span>
            </summary>
            <ul className="divide-y divide-line border-t border-line">
              {g.items.map((c) => {
                const on = combo.conds.includes(c.key);
                return (
                  <li key={c.key}>
                    <button type="button" aria-pressed={on} onClick={() => setCombo((x) => toggleCheck(x, c.key))} className={`flex w-full items-start gap-2 px-3 py-2 text-left ${on ? 'bg-accent2-soft' : ''}`}>
                      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? 'border-accent bg-accent text-on-accent' : 'border-line'}`}>{on && <Check className="h-3 w-3" />}</span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
                          {c.label} <Badge>{KIND_WORD[c.kind]}</Badge>
                          <VerdictBadge verdict={c.verdict} />
                          {needsText(c) && <Badge tone="warn">{needsText(c)}</Badge>}
                        </span>
                        <span className="block text-[11px] leading-snug text-muted">{c.text}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
        {!list.groups.length && <p className="text-xs text-muted">No check matches that search.</p>}
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || n === 0} onClick={() => onSave(combo)}>
          Save combination
        </button>
      </div>
    </Card>
  );
}

/**
 * Account > Entries: build entries from several checks at once (indicators, chart patterns, volume and VWAP, the 50-stock breadth).
 * A combination fires on the first bar where enough of its checks hold, for a call/buy when they point up and a put/short when they point down.
 * The same combinations are tested in the study and used live. `endpoint` is '/options' or '/auto'.
 */
export function ComboBuilder({ kind, endpoint, combos, reload }) {
  const catalog = useApi('/combos/catalog', []);
  const study = useApi(`/study/${kind}`, []);
  const [editing, setEditing] = useState(null); // null, 'new' or a combination id
  const [busy, setBusy] = useState(false);
  const verdicts = useMemo(() => verdictMap(study.data?.result?.indicators), [study.data]);
  const saved = combos || [];

  async function put(next) {
    setBusy(true);
    try {
      await api(endpoint, { method: 'PUT', body: { combos: next } });
      reload();
      return true;
    } catch (e) {
      toast.error(e.message || 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(combo) {
    const list = saved.map((c, i) => toPayload(fromSaved(c), i));
    const payload = toPayload(combo, saved.length);
    const next = editing === 'new' ? [...list, payload] : list.map((c) => (c.id === editing ? { ...payload, id: c.id } : c));
    if (await put(next)) setEditing(null);
  }

  const toggleOn = (id) => put(saved.map((c, i) => ({ ...toPayload(fromSaved(c), i), on: c.id === id ? !c.on : c.on })));
  const remove = (id) => put(saved.filter((c) => c.id !== id).map((c, i) => toPayload(fromSaved(c), i)));

  return (
    <div className="space-y-2">
      <div>
        <p className="text-[11px] leading-snug text-muted">
          <b className="text-fg">My combinations.</b> Pick several checks (indicators, chart patterns, volume and VWAP, the 50-stock breadth) and the bot buys only when enough of them agree. {kind === 'options' ? 'A call when they point up, a put when they point down.' : 'A buy when they point up, a short sale when they point down.'} The study tests the same combinations, so you see what they would have earned before you switch them on.
        </p>
      </div>
      {!catalog.data && <Skeleton className="h-16" />}
      {catalog.data && (
        <>
          {saved.length === 0 && editing == null && <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">No combination yet. Run the study first: its Indicators list marks each check Keep or Drop, so you start from the ones that earned.</p>}
          <ul className="space-y-2">
            {saved.map((c) =>
              editing === c.id ? (
                <li key={c.id}>
                  <Editor catalog={catalog.data} kind={kind} verdicts={verdicts} initial={fromSaved(c)} busy={busy} onCancel={() => setEditing(null)} onSave={save} />
                </li>
              ) : (
                <li key={c.id}>
                  <Card className="space-y-1.5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{c.name}</div>
                        <div className="text-[11px] text-muted">{ruleText(fromSaved(c))}</div>
                      </div>
                      <Switch on={c.on} disabled={busy} label={`Use ${c.name}`} onClick={() => toggleOn(c.id)} />
                    </div>
                    <p className="text-[11px] leading-snug text-muted">{c.conds.map((k) => catalog.data.conditions.find((x) => x.key === k)?.label || k).join(' + ')}</p>
                    <div className="flex justify-end gap-2">
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(c.id)} disabled={busy}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => remove(c.id)} disabled={busy} aria-label={`Delete ${c.name}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </Card>
                </li>
              ),
            )}
          </ul>
          {editing === 'new' ? (
            <Editor catalog={catalog.data} kind={kind} verdicts={verdicts} initial={blankCombo()} busy={busy} onCancel={() => setEditing(null)} onSave={save} />
          ) : (
            editing == null &&
            saved.length < 12 && (
              <button type="button" className="btn btn-sm w-full" onClick={() => setEditing('new')}>
                <Plus className="h-3.5 w-3.5" /> New combination
              </button>
            )
          )}
        </>
      )}
    </div>
  );
}
