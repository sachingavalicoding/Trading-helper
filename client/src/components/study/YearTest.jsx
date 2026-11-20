import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { Badge, Card, Segmented, Skeleton } from '../ui.jsx';

// Research > Year test: ONE thing (score bot or one combination, shares or options) over months of the year candle files, fast,
// in the background on the server. The phone can close; the result is saved month by month and the run carries on after a restart.

const monthText = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const dayText = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '—');
const mins = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

function Stat({ label, value, cls = '' }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`num text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function Rows({ title, rows, label }) {
  if (!rows?.length) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted">{title}</div>
      <ul className="divide-y divide-line rounded-lg border border-line text-xs">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="min-w-0 truncate">{label ? label(r) : r.key}</span>
            <span className="shrink-0 text-muted">{r.trades} tr · {r.winRate}%</span>
            <span className={`num w-20 shrink-0 text-right font-semibold ${pnlClass(r.net)}`}>{formatPnl(r.net)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Result({ run }) {
  const r = run.result;
  const est = run.spec.side === 'options';
  return (
    <div className="space-y-3">
      {est && <div className="rounded-lg bg-warn/15 px-2 py-1.5 text-xs text-warn">Options: premiums are ESTIMATED by the model on these months, not real prices.</div>}
      {run.check?.verdict && (
        <div className={`rounded-lg px-2 py-1.5 text-xs ${run.check.verdict.trusted === false ? 'bg-down/15 text-down' : run.check.verdict.trusted ? 'bg-up/15 text-up' : 'bg-surface-2 text-muted'}`}>
          <b>Fast vs full Replay: </b>{run.check.verdict.text}
          {run.check.rows?.filter((x) => x.fast).map((x) => (
            <div key={x.day} className="mt-0.5 text-[11px]">{dayText(x.day)}: fast {x.fast.trades} tr {formatPnl(x.fast.net)} · Replay {x.full ? `${x.full.trades} tr ${formatPnl(x.full.net)}` : x.error || 'no result'}</div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="P&L after charges" value={formatPnl(r.net)} cls={pnlClass(r.net)} />
        <Stat label="Trades" value={r.trades} />
        <Stat label="Win rate" value={`${r.winRate}%`} />
        <Stat label="Without best day" value={formatPnl(r.withoutBestDay)} cls={pnlClass(r.withoutBestDay)} />
        <Stat label="Green / red days" value={`${r.greenDays} / ${r.redDays}`} />
        <Stat label="Days" value={r.days} />
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        {r.bestMonth && <Stat label={`Best month (${monthText(r.bestMonth.key)})`} value={formatPnl(r.bestMonth.net)} cls={pnlClass(r.bestMonth.net)} />}
        {r.worstMonth && <Stat label={`Worst month (${monthText(r.worstMonth.key)})`} value={formatPnl(r.worstMonth.net)} cls={pnlClass(r.worstMonth.net)} />}
        {r.bestDay && <Stat label={`Best day (${dayText(r.bestDay.day)})`} value={formatPnl(r.bestDay.net)} cls={pnlClass(r.bestDay.net)} />}
        {r.worstDay && <Stat label={`Worst day (${dayText(r.worstDay.day)})`} value={formatPnl(r.worstDay.net)} cls={pnlClass(r.worstDay.net)} />}
      </div>
      {r.untouched?.from && (
        <div className="rounded-lg bg-surface-2 px-2 py-1.5 text-xs">
          <b>Days never used for tuning</b> (before {dayText(r.untouched.from)}, when the saved data that Learn and the studies use begins): {r.untouched.days} days, {r.untouched.trades} trades, {r.untouched.winRate}% won, <span className={pnlClass(r.untouched.net)}>{formatPnl(r.untouched.net)}</span>. This is the honest part of the result.
        </div>
      )}
      <Rows title="Each month" rows={r.perMonth} label={(x) => `${monthText(x.key)} (${x.days} d)`} />
      <Rows title={run.spec.what === 'score' ? 'Each score entry' : 'Buys and sells'} rows={r.perEntry} />
      {r.secondsPerDay != null && <div className="text-[11px] text-muted">Run time: {mins(r.seconds)} for {r.days} days ({r.secondsPerDay} s a day). 6 months is about {mins(r.secondsPerDay * 125)}.</div>}
    </div>
  );
}

export function YearTest() {
  const { data, error, reload } = useApi('/year-test');
  const [side, setSide] = useState('shares');
  const [what, setWhat] = useState('score');
  const [entry, setEntry] = useState('all');
  const [combo, setCombo] = useState('');
  const [months, setMonths] = useState(6);
  const [busy, setBusy] = useState(false);
  const run = data?.run;
  const active = run?.state === 'running' || run?.state === 'checking';

  useEffect(() => {
    if (!active) return undefined;
    const t = setTimeout(reload, 5000);
    return () => clearTimeout(t);
  }, [active, data, reload]);

  async function call(path, body = {}) {
    setBusy(true);
    try {
      await api(`/year-test/${path}`, { method: 'POST', body });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not start');
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <Card className="p-3 text-sm text-down">{error.message}</Card>;
  if (!data) return <Skeleton className="h-48 w-full" />;
  const combos = data.combos[side] ?? [];
  const have = side === 'shares' ? data.data.shares : data.data.nifty;
  const done = run?.months?.filter((m) => m.done).length ?? 0;

  return (
    <Card className="space-y-3 p-3">
      <div>
        <div className="text-sm font-semibold">Year test: one thing over many months</div>
        <p className="mt-0.5 text-xs text-muted">{data.note}</p>
      </div>
      <div className="text-xs text-muted">Year files: {have.days ? `${have.days} days, ${dayText(have.from)} to ${dayText(have.to)}` : 'none yet. Download or import them in Research > Saved data.'}</div>
      <div className="space-y-2">
        <Segmented className="w-full" size="sm" value={side} onChange={(v) => { setSide(v); setCombo(''); }} options={[{ value: 'shares', label: 'Shares' }, { value: 'options', label: 'Options (estimated)' }]} />
        <Segmented className="w-full" size="sm" value={what} onChange={setWhat} options={[{ value: 'score', label: side === 'shares' ? 'Scanner / score bot' : 'Score bot' }, { value: 'combo', label: 'One combination' }]} />
        {what === 'score' && side === 'shares' && (
          <select className="input w-full" value={entry} onChange={(e) => setEntry(e.target.value)}>
            <option value="all">All your switched-on setups</option>
            {data.setups.map((s) => <option key={s} value={s}>{s} only</option>)}
          </select>
        )}
        {what === 'combo' && (
          <select className="input w-full" value={combo} onChange={(e) => setCombo(e.target.value)}>
            <option value="">Pick a combination</option>
            {combos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <Segmented className="w-full" size="sm" value={months} onChange={setMonths} options={data.monthChoices.map((m) => ({ value: m, label: `${m} mo` }))} />
        <button type="button" className="btn btn-primary w-full" disabled={busy || active || !have.days || (what === 'combo' && !combo)} onClick={() => call('start', { side, what, entry, combo: combo || null, months })}>
          Start the year test
        </button>
      </div>

      {run && (
        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-sm font-semibold">{run.label}</div>
            <Badge tone={active ? 'accent' : run.state === 'done' ? 'up' : run.state === 'failed' ? 'down' : 'warn'}>{run.state}</Badge>
          </div>
          {active && (
            <div className="space-y-1">
              <div className="h-1.5 overflow-hidden rounded bg-surface-3"><div className="h-full bg-accent" style={{ width: `${Math.round((done / Math.max(1, run.months.length)) * 100)}%` }} /></div>
              <div className="text-xs text-muted">{done} of {run.months.length} months · {run.step}. You can close the app: it keeps running on the server.</div>
              <button type="button" className="btn btn-secondary btn-sm w-full" disabled={busy} onClick={() => call('stop')}>Stop</button>
            </div>
          )}
          {run.error && <div className="text-xs text-down">{run.error}</div>}
          {!active && run.state !== 'done' && done < run.months.length && <button type="button" className="btn btn-secondary btn-sm w-full" disabled={busy} onClick={() => call('resume')}>Carry on from month {done + 1}</button>}
          {done > 0 && <Result run={run} />}
          {!active && done > 0 && <button type="button" className="btn btn-secondary btn-sm w-full" disabled={busy} onClick={() => call('check')}>Check again against full Replay</button>}
        </div>
      )}
    </Card>
  );
}
