import { useState } from 'react';
import { Check, Play, Undo2, X } from 'lucide-react';
import { istStamp } from '../../lib/study.js';
import { compareRows, comboBox, comboApplyState } from '../../lib/learn.js';
import { Card, Fold, Sheet } from '../ui.jsx';

const stamp = (iso) => istStamp(Date.parse(iso) / 1000);
const BOX = { up: 'border-up bg-up-soft', down: 'border-down bg-down-soft', warn: 'border-warn bg-warn/10', muted: 'border-line bg-surface-2' };
const TEXT = { up: 'text-up', down: 'text-down', warn: 'text-warn', muted: 'text-fg' };
const rs = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v ?? 0)).toLocaleString('en-IN')}`;

function Table({ part, title }) {
  const rows = compareRows(part);
  if (!rows.length) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-line text-[11px]">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 bg-surface-2 px-2 py-1 font-semibold text-muted">
        <span>{title}</span>
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

function Rows({ list }) {
  return (
    <div className="space-y-0.5 text-[11px]">
      {list.map((x) => (
        <div key={x.key} className="flex justify-between gap-2">
          <span className="truncate text-muted">{x.key}</span>
          <span className={`num shrink-0 ${x.net > 0 ? 'text-up' : x.net < 0 ? 'text-down' : ''}`}>{x.trades} · {x.wins} won · {rs(x.net)}</span>
        </div>
      ))}
    </div>
  );
}

/** Learn > Shares: the share auto trader's settings (entry hours, setups, entry rules, exit) tuned on the saved days, checked on hidden days. */
export function SharesLearn({ view, busy, running, act }) {
  const [asking, setAsking] = useState(false);
  const r = view?.shares;
  const box = r?.verdict && r.verdict !== 'short' ? comboBox(r.verdict === 'same' ? { verdict: 'same' } : r) : null;
  const can = comboApplyState(r ? { ...r, gone: false } : null);
  return (
    <div className="space-y-3">
      <Card className="space-y-2.5 p-3">
        <p className="text-[11px] leading-snug text-muted">
          The scanner is replayed on the last 15 saved days as live, then it tries your share settings: <b className="text-fg">the time of the last new trade</b>, the first trade time, which setups trade, the entry rules (Nifty must agree, stronger than Nifty, volume, wait for a close, smallest stop) and the exit (your ladder, a lock in risks or a fixed target). The newest days stay hidden for the check. It does not touch the minimum score, the daily loss limit or stop-after-losses.
        </p>
        <button type="button" className="btn btn-secondary w-full" disabled={running || busy || !view} onClick={() => act('/run', { days: 30, what: 'shares' })}>
          <Play className="h-4 w-4" /> {running ? 'Learning…' : 'Learn shares (a few minutes)'}
        </button>
        {r?.error && <p className="text-[11px] text-down">{r.error}</p>}
      </Card>

      {!r?.verdict && !running && <p className="px-1 text-xs text-muted">Not run yet.</p>}
      {r?.verdict === 'short' && <p className="px-1 text-xs text-warn">{r.text}</p>}
      {box && (
        <div className={`space-y-2 rounded-2xl border-2 p-3 ${BOX[box.tone]}`} role="status">
          <div className="flex items-center justify-between gap-2">
            <span className={`flex items-center gap-1.5 text-base font-bold ${TEXT[box.tone]}`}>
              {box.tone === 'up' ? <Check className="h-5 w-5" /> : box.tone === 'down' ? <X className="h-5 w-5" /> : null}
              {r.verdict === 'same' ? 'No better share settings found' : box.title}
            </span>
            <span className="text-[11px] text-muted">{stamp(r.at)}</span>
          </div>
          <p className="text-xs leading-snug">{r.text}</p>
          {r.changes?.map((c) => (
            <div key={c.label} className="rounded-lg bg-surface p-2 text-[11px] leading-snug">
              <div className="font-semibold">{c.group}: {c.to}</div>
              <div className="text-muted">now: {c.from}</div>
            </div>
          ))}
          {r.changes?.length > 0 && <Table part={r.hidden} title={`Hidden ${r.split?.hiddenDays} days`} />}
          {can.action === 'apply' && (
            <button type="button" className="btn btn-primary w-full" disabled={busy || running} onClick={() => act('/shares/apply', { force: false }, 'Applied to your paper share settings.')}>Apply to my share settings</button>
          )}
          {can.action === 'confirm' && (
            <button type="button" className="btn btn-outline-down btn-sm w-full" disabled={busy || running} onClick={() => setAsking(true)}>Apply anyway…</button>
          )}
          {can.why && <p className="text-[11px] text-muted">{can.why.replace('This combination was', 'Your share settings were')}</p>}
          {r.canUndo && (
            <button type="button" className="btn btn-secondary btn-sm w-full" disabled={busy || running} onClick={() => act('/shares/undo', undefined, 'Your old share settings are back.')}>
              <Undo2 className="h-4 w-4" /> Undo
            </button>
          )}
        </div>
      )}
      {r?.facts && (
        <Card className="space-y-2 p-3">
          <h3 className="text-sm font-semibold">What your share settings now made ({r.split?.from} to {r.split?.to})</h3>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">By setup</div>
          <Rows list={r.facts.bySetup} />
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">By hour of entry</div>
          <Rows list={r.facts.byHour} />
        </Card>
      )}
      {r?.all && r.changes?.length > 0 && (
        <Fold id="learn-shares-all" title="All days: now against new" summary="Includes the days it learned on, so it flatters the new settings">
          <Table part={r.all} title="All days" />
        </Fold>
      )}
      {r?.notes?.map((n) => <p key={n} className="px-1 text-[11px] text-muted">{n}</p>)}

      {asking && (
        <Sheet title="Apply anyway?" subtitle="Did not pass the hidden days" onClose={() => setAsking(false)}>
          <div className="space-y-3 pt-2 text-xs leading-snug">
            <p>{r?.text}</p>
            <p className="text-muted">It changes your paper share settings only, and Undo puts them back.</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setAsking(false)}>Cancel</button>
              <button type="button" className="btn btn-sell" disabled={busy} onClick={() => { act('/shares/apply', { force: true }, 'Applied anyway.'); setAsking(false); }}>Yes, apply</button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
