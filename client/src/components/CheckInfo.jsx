import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { api } from '../lib/api.js';
import { Sheet } from './ui.jsx';
import { CheckExamples } from './ExampleChart.jsx';

// The info button beside an indicator, a pattern or a combination: a sheet that says, in plain words, what it measures, exactly when it
// is true (with the app's own numbers), how it works for a put, and how long it counts. The words come from the server catalog.

let cached = null;
/** The check catalog, fetched once for the whole app. */
export function useCatalog() {
  const [data, setData] = useState(cached?.data ?? null);
  useEffect(() => {
    if (cached?.data) return undefined;
    let live = true;
    if (!cached) cached = { promise: api('/combos/catalog').then((d) => (cached.data = d)).catch((e) => { cached = null; throw e; }) };
    cached.promise.then((d) => live && setData(d)).catch(() => {});
    return () => { live = false; };
  }, []);
  return data;
}

/** The catalog key for what the app shows: a check key as it is, a study pattern key ('breakout') as its check ('p_breakout'). */
export function checkKey(catalog, key) {
  if (!catalog || !key) return null;
  if (catalog.conditions.some((c) => c.key === key)) return key;
  return catalog.conditions.some((c) => c.key === `p_${key}`) ? `p_${key}` : null;
}

function OneCheck({ c, open }) {
  const h = c.how || {};
  return (
    <details open={open} className="rounded-xl border border-line">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
        {c.label}
        <span className="block text-[11px] font-normal text-muted">{h.name} · {c.kind === 'event' ? 'event' : 'state'}</span>
      </summary>
      <div className="space-y-2 border-t border-line px-3 py-2 text-xs leading-snug">
        {h.what && <p><b>What it measures.</b> {h.what}</p>}
        {h.idea && <p><b>The idea.</b> {h.idea}</p>}
        <p><b>When it triggers.</b> {h.when}</p>
        <p><b>For a put.</b> {h.put}</p>
        <p><b>How long it counts.</b> {h.counts}</p>
        {h.needs && <p className="text-warn">{h.needs}</p>}
        <p className="text-muted">{h.note}</p>
      </div>
    </details>
  );
}

/** The sheet for one check or a list of them (a combination). `rule` is the combination's rule in words, when there is one. */
export function CheckInfoSheet({ title, keys, rule, onClose }) {
  const catalog = useCatalog();
  const rows = catalog ? keys.map((k) => catalog.conditions.find((c) => c.key === checkKey(catalog, k))).filter(Boolean) : [];
  return (
    <Sheet title={title} subtitle={keys.length > 1 ? 'How each check works and when it triggers' : 'How it works and when it triggers'} onClose={onClose}>
      <div className="space-y-2 pt-2">
        {rule && <p className="rounded-lg bg-surface-2 p-2 text-xs leading-snug">{rule}</p>}
        {catalog && rows.length > 0 && <CheckExamples keys={rows.map((c) => c.key)} />}
        {!catalog && <p className="text-xs text-muted">Loading…</p>}
        {catalog && rows.length === 0 && <p className="text-xs text-muted">No notes for this one.</p>}
        {rows.map((c) => <OneCheck key={c.key} c={c} open={rows.length === 1} />)}
        <p className="text-[11px] leading-snug text-muted">A check that won often in the past is not a promise. Each one is a rule about the last closed bars; the market can do the opposite right after.</p>
      </div>
    </Sheet>
  );
}

/** A small round "i" button that opens the sheet. Put it beside (never inside) another button. */
export function InfoButton({ keys, title, rule = null, text = null, className = '' }) {
  const [open, setOpen] = useState(false);
  const list = [].concat(keys).filter(Boolean);
  if (!list.length) return null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        aria-label={`About ${title}`}
        title="How it works"
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg ${className}`}
      >
        <Info className="h-4 w-4" />
        {text && <span>{text}</span>}
      </button>
      {open && <CheckInfoSheet title={title} keys={list} rule={rule} onClose={() => setOpen(false)} />}
    </>
  );
}
