import { useState } from 'react';
import { Check, Play, Undo2, X } from 'lucide-react';
import { istStamp } from '../../lib/study.js';
import { comboBox, comboApplyState, compareRows, sortCombos } from '../../lib/learn.js';
import { Card, Fold, Sheet } from '../ui.jsx';

const stamp = (iso) => istStamp(Date.parse(iso) / 1000);
const BOX = { up: 'border-up bg-up-soft', down: 'border-down bg-down-soft', warn: 'border-warn bg-warn/10', muted: 'border-line bg-surface-2' };
const TEXT = { up: 'text-up', down: 'text-down', warn: 'text-warn', muted: 'text-fg' };
const rs = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v ?? 0)).toLocaleString('en-IN')}`;

/** Hidden days old against new, in one short table. */
function Mini({ part }) {
  const rows = compareRows(part).filter((r) => ['net', 'badDays', 'winRate', 'payoff'].includes(r.key));
  if (!rows.length) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-line text-[11px]">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 bg-surface-2 px-2 py-1 font-semibold text-muted">
        <span>Hidden days</span>
        <span className="w-16 text-right">Now</span>
        <span className="w-16 text-right">New</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-t border-line px-2 py-1">
          <span className="text-muted">{r.label}</span>
          <span className="num w-16 text-right">{r.old}</span>
          <span className={`num w-16 text-right font-semibold ${r.better ? 'text-up' : r.worse ? 'text-down' : ''}`}>{r.new}</span>
        </div>
      ))}
    </div>
  );
}

/** One combination's result: what to change, what its own trades say, and Apply / Undo. */
function ComboResult({ r, busy, running, act, onAsk }) {
  const box = comboBox(r);
  const can = comboApplyState(r);
  return (
    <div className={`space-y-2 rounded-2xl border-2 p-3 ${BOX[box.tone]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{r.name}</div>
          <div className={`flex items-center gap-1 text-xs font-bold ${TEXT[box.tone]}`}>
            {box.tone === 'up' ? <Check className="h-4 w-4" /> : box.tone === 'down' ? <X className="h-4 w-4" /> : null}
            {box.title}
            {!r.wasOn && <span className="font-normal text-muted"> · switched off now</span>}
          </div>
        </div>
        {r.all?.old && <span className="num shrink-0 text-[11px] text-muted">{r.all.old.trades} trades · {rs(r.all.old.net)}</span>}
      </div>
      <p className="text-[11px] leading-snug">{r.text}</p>
      {r.changes?.length > 0 && (
        <div className="space-y-1">
          {r.changes.map((c) => (
            <div key={c.label} className="rounded-lg bg-surface p-2 text-[11px] leading-snug">
              <div className="font-semibold">{c.group}: {c.to}</div>
              <div className="text-muted">now: {c.from}</div>
            </div>
          ))}
        </div>
      )}
      {r.hidden && r.changes?.length > 0 && <Mini part={r.hidden} />}
      {r.notes?.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-muted">
          {r.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {can.action === 'apply' && (
        <button type="button" className="btn btn-primary btn-sm w-full" disabled={busy || running} onClick={() => act('/combo/apply', { id: r.id, force: false }, `${r.name}: applied.`)}>
          Apply to this combination
        </button>
      )}
      {can.action === 'confirm' && (
        <button type="button" className="btn btn-outline-down btn-sm w-full" disabled={busy || running} onClick={() => onAsk(r)}>Apply anyway…</button>
      )}
      {can.why && <p className="text-[11px] text-muted">{can.why}</p>}
      {r.canUndo && (
        <button type="button" className="btn btn-secondary btn-sm w-full" disabled={busy || running} onClick={() => act('/combo/undo', { id: r.id }, `${r.name}: put back.`)}>
          <Undo2 className="h-4 w-4" /> Undo
        </button>
      )}
    </div>
  );
}

/** Learn > Each combination: each Nifty combination tuned on its own (side, extra indicator, own ladder, own loss cut, trail), one tap to apply. */
export function ComboLearn({ view, days, busy, running, act }) {
  const [asking, setAsking] = useState(null);
  const combos = view?.combos;
  const list = sortCombos(combos?.list ?? []);
  const passed = list.filter((r) => r.verdict === 'passed').length;
  return (
    <div className="space-y-3">
      <Card className="space-y-2.5 p-3">
        <p className="text-[11px] leading-snug text-muted">
          Each combination on its own: calls, puts or both, an extra indicator (yesterday&apos;s close, high, pivot and CPR too), <b className="text-fg">its own profit ladder</b> (small targets like +₹750 keep ₹700 too) and <b className="text-fg">its own loss cut</b> in rupees, sized from its own trades: where its winners never went below, and where its trades never came back from. A change must help through most of the learning days, not one lucky day, and then pass the hidden newest days.
        </p>
        <button type="button" className="btn btn-secondary w-full" disabled={running || busy || !view} onClick={() => act('/run', { days: Number(days), what: 'combos' })}>
          <Play className="h-4 w-4" /> {running ? 'Learning…' : 'Tune each combination (about 5 minutes)'}
        </button>
        {combos?.error && <p className="text-[11px] text-down">{combos.error}</p>}
      </Card>

      {!combos?.list && !running && <p className="px-1 text-xs text-muted">Not run yet.</p>}
      {combos?.list && (
        <>
          <p className="px-1 text-[11px] text-muted">
            {stamp(combos.at)}{combos.by === 'evening' ? ' (evening run)' : ''} · {combos.daysAsked} days, {combos.pricing === 'real' ? 'real option prices' : 'estimated option prices'} · {passed} of {list.length} passed
          </p>
          {combos.notes?.map((n) => <p key={n} className="px-1 text-[11px] text-warn">{n}</p>)}
          {list.filter((r) => ['passed', 'thin', 'failed'].includes(r.verdict)).map((r) => (
            <ComboResult key={r.id} r={r} busy={busy} running={running} act={act} onAsk={setAsking} />
          ))}
          {list.some((r) => ['same', 'few', 'short'].includes(r.verdict)) && (
            <Fold id="learn-combos-rest" title="Nothing to change" summary={`${list.filter((r) => ['same', 'few', 'short'].includes(r.verdict)).length} combinations`}>
              <div className="space-y-2">
                {list.filter((r) => ['same', 'few', 'short'].includes(r.verdict)).map((r) => (
                  <div key={r.id} className="space-y-1 border-t border-line pt-2 text-[11px] first:border-0 first:pt-0">
                    <div className="font-semibold">{r.name}</div>
                    <p className="text-muted">{r.text}</p>
                    {r.notes?.map((n) => <p key={n} className="text-muted">· {n}</p>)}
                  </div>
                ))}
              </div>
            </Fold>
          )}
        </>
      )}

      {asking && (
        <Sheet title="Apply anyway?" subtitle={asking.name} onClose={() => setAsking(null)}>
          <div className="space-y-3 pt-2 text-xs leading-snug">
            <p>{asking.text}</p>
            <p className="text-muted">It changes this paper combination only, and Undo puts it back.</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setAsking(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-sell"
                disabled={busy}
                onClick={() => {
                  act('/combo/apply', { id: asking.id, force: true }, `${asking.name}: applied anyway.`);
                  setAsking(null);
                }}
              >
                Yes, apply
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
