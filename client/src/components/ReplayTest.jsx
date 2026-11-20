import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { formatPnl, pnlClass } from '../lib/format.js';
import { Card } from './ui.jsx';

// Replay test, step by step: plays past days with your settings now, then each change Learn suggested on top of the best so far.
// A change is kept only if it earns more over all the days AND on the newest days. Replay plays only Learn's best few ideas (it takes minutes a day); Learn's own numbers are estimates. Each run has its own copy of the settings; your live
// settings change only when you press Apply, and Apply opens only when something was kept.

const dayText = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const VERDICT = {
  base: { text: 'Start', cls: 'bg-surface-3 text-fg' },
  kept: { text: 'Kept', cls: 'bg-up/20 text-up' },
  dropped: { text: 'Dropped', cls: 'bg-down/15 text-down' },
  skipped: { text: 'Skipped', cls: 'bg-surface-3 text-muted' },
  running: { text: 'Running', cls: 'bg-warn/20 text-warn' },
  waiting: { text: 'Waiting', cls: 'bg-surface-3 text-muted' },
};

function Choice({ label, options, value, onChange, fmt }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="grid grid-cols-4 gap-1">
        {options.map((x) => (
          <button key={x} type="button" onClick={() => onChange(x)} className={`btn btn-sm ${value === x ? 'btn-primary' : 'btn-secondary'}`}>{fmt(x)}</button>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, cls = '' }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`num text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function StepRow({ s, i, hidden, base, total }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT[s.verdict] ?? VERDICT.waiting;
  const m = s.summary;
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-muted">Step {i + 1}</div>
          <div className="text-sm font-semibold">{s.name}</div>
          {s.changes?.length > 0 && <div className="mt-0.5 text-[11px] text-muted">{s.changes.join(' · ')}</div>}
          {s.learnVerdict && <div className="mt-0.5 text-[11px] text-muted">Learn estimated {formatPnl(s.learnGain)} over its days ({s.learnVerdict}); Replay is the real check.</div>}
        </div>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${v.cls}`}>{v.text}</span>
      </div>
      {m && (
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <Stat label="Profit" value={formatPnl(m.net)} cls={pnlClass(m.net)} />
          <Stat label="Win rate" value={`${m.winRate}%`} />
          <Stat label="Trades" value={m.trades} />
          <Stat label="Worst day" value={m.worstDay ? formatPnl(m.worstDay.net) : '—'} cls={pnlClass(m.worstDay?.net)} />
          <Stat label="Bad days" value={`${m.badDays} of ${m.days}`} />
          <Stat label="Newest days" value={formatPnl(m.hiddenNet)} cls={pnlClass(m.hiddenNet)} />
        </div>
      )}
      {m && base && s.verdict !== 'base' && (
        <div className="mt-1.5 text-[11px] text-muted">
          vs start: <span className={pnlClass(m.net - base.net)}>{formatPnl(m.net - base.net)}</span> over all days, <span className={pnlClass(m.hiddenNet - base.hiddenNet)}>{formatPnl(m.hiddenNet - base.hiddenNet)}</span> on the newest days
        </div>
      )}
      {s.why && <p className="mt-1.5 text-xs leading-snug">{s.why}</p>}
      {s.results?.[0]?.reused && <p className="mt-1 text-[11px] text-muted">Only the {s.results[0].reused === 'shares' ? 'options' : 'shares'} bot was replayed for this change; the {s.results[0].reused} days are the best run's (they would trade the same).</p>}
      {s.verdict === 'running' && <p className="mt-1.5 text-xs text-muted">{s.results?.length ?? 0} of {total} days done</p>}
      {s.results?.length > 0 && (
        <button type="button" className="mt-1.5 text-xs text-accent" onClick={() => setOpen(!open)}>{open ? 'Hide days' : 'Each day'}</button>
      )}
      {open && (
        <table className="mt-1.5 w-full text-xs">
          <tbody>
            {s.results.map((r) => (
              <tr key={r.day} className="border-t border-line">
                <td className="py-1">{dayText(r.day)}{hidden.includes(r.day) && <span className="ml-1 rounded bg-accent/15 px-1 text-[10px] text-accent">newest</span>}</td>
                <td className="py-1 text-muted">{r.trades} trade{r.trades === 1 ? '' : 's'}, {r.wins} won</td>
                <td className={`num py-1 text-right ${pnlClass(r.net)}`}>{formatPnl(r.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

/** Account card: test Learn's changes by replaying past days, step by step, and apply only what won. */
export function ReplayTestCard() {
  const [d, setD] = useState(null);
  const [days, setDays] = useState(5);
  const [slip, setSlip] = useState(0.5);
  const [delay, setDelay] = useState(2);
  const [parallel, setParallel] = useState(2);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer;
    const load = () =>
      api('/replay-day/test')
        .then((x) => {
          if (!alive) return;
          setD(x);
          if (x.running) timer = setTimeout(load, 5000);
        })
        .catch(() => alive && setD((cur) => cur ?? { error: true }));
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [d?.running]);

  async function act(path, body) {
    setBusy(true);
    try {
      setD(await api(`/replay-day/test/${path}`, { method: 'POST', body }));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!d) return null;
  if (d.error) return null;
  const t = d.test;
  const base = t?.steps?.[0]?.summary;
  const kept = t?.steps?.filter((s) => s.verdict === 'kept') ?? [];
  const best = [...(t?.steps ?? [])].reverse().find((s) => s.verdict === 'kept' || s.verdict === 'base')?.summary;
  const runs = (d.candidates.length + 1) * days;
  const together = Math.min(parallel, d.choices?.parallel?.at(-1) ?? 1);
  const minutes = Math.max(5, Math.round((Math.ceil(runs / together) * 2.5) / 5) * 5);
  const canApply = t?.state === 'done' && kept.length > 0 && !t.applied && !d.stale;

  async function apply() {
    if (!window.confirm(`Put these ${kept.length} change(s) in place in your live paper settings?\n\n${kept.map((s) => `• ${s.name}`).join('\n')}\n\nYour daily loss limit stays as it is.`)) return;
    await act('apply');
    toast.success('Applied. Undo is in Research > Learn.');
  }

  return (
    <Card className="p-4">
      <div className="text-sm font-semibold">Replay test: step up your settings</div>
      <div className="text-xs text-muted">Plays past days with your settings now, then tries each change Learn suggested, one at a time. A change is kept only if it earns more over all the days and on the newest days. Your live settings are not touched until you press Apply.</div>

      {!d.running && (
        <div className="mt-3 space-y-3">
          {d.candidates.length === 0 ? (
            <p className="text-xs text-muted">Learn has no suggested change to test yet. Run Learn first (Research &gt; Learn), then come back.</p>
          ) : (
            <>
              <div className="text-xs">
                <span className="text-muted">Changes to try (Learn's best {d.candidates.length}{d.notChecked > 0 ? `, ${d.notChecked} weaker not played` : ''}): </span>
                {d.candidates.map((c) => c.name).join(' · ')}
              </div>
              <Choice label="Days (newest saved days)" options={d.choices.days} value={days} onChange={setDays} fmt={(x) => `${x} days`} />
              <Choice label="Slippage (fill worse than the price seen)" options={d.choices.slippage} value={slip} onChange={setSlip} fmt={(x) => `${x}%`} />
              <Choice label="Fill delay (market orders)" options={d.choices.delay} value={delay} onChange={setDelay} fmt={(x) => `${x}s`} />
              <Choice label="Days at once (same result, faster; 3-4 needs a strong computer, use 1 on a phone)" options={d.choices.parallel} value={together} onChange={setParallel} fmt={(x) => `${x}`} />
              <p className="text-[11px] leading-snug text-muted">
                {runs} day runs, {together} at a time (about {minutes} minutes on a laptop, often less: a change to one bot replays only that bot). The app stays usable. All days play on 1-minute candles, the same way for every day. The newest {Math.max(1, Math.round(days / 3))} day(s) are the check a change must pass.
              </p>
              <button type="button" className="btn btn-primary w-full" disabled={busy || d.days.length < days} onClick={() => act('start', { days, slippagePct: slip, fillDelaySec: delay, parallel: together })}>
                {d.days.length < days ? `Only ${d.days.length} days saved` : 'Start replay test'}
              </button>
            </>
          )}
        </div>
      )}

      {t && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted">
              {t.days?.length} days, {dayText(t.days[0])} to {dayText(t.days.at(-1))} · slippage {t.fill?.slippagePct}% · delay {t.fill?.fillDelaySec}s{t.fill?.parallel ? ` · ${t.fill.parallel} at once` : ''}
            </span>
            {d.running && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act('stop')}>Stop</button>}
          </div>
          {d.running && t.at && <p className="text-xs text-warn">Now playing {dayText(t.at.day)} for step {t.at.step + 1}…</p>}
          {t.state === 'failed' && <p className="text-xs text-down">{t.error}</p>}
          {t.state === 'stopped' && <p className="text-xs text-muted">{t.error || 'Stopped.'}</p>}
          {t.state === 'done' && base && best && (
            <div className="rounded-xl border border-line p-3 text-sm">
              {kept.length ? (
                <>
                  <span className="font-semibold">Best found: </span>
                  <span className={pnlClass(best.net)}>{formatPnl(best.net)}</span> vs <span className={pnlClass(base.net)}>{formatPnl(base.net)}</span> now over {t.days.length} days.
                  <div className="mt-0.5 text-xs text-muted">Past days, not a promise. Paper trade it for a few days before trusting it.</div>
                </>
              ) : (
                <>No change beat your settings on the newest days. Keep what you have.</>
              )}
            </div>
          )}
          <ol className="space-y-2">
            {t.steps.map((s, i) => (
              <StepRow key={s.key} s={s} i={i} hidden={t.hidden} base={base} total={t.days.length} />
            ))}
          </ol>
          {t.state === 'done' && kept.length > 0 && (
            <>
              {t.applied ? (
                <p className="text-xs text-up">Applied {new Date(t.applied.at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })}.</p>
              ) : d.stale ? (
                <p className="text-xs text-warn">Your settings changed after this test, so Apply is closed. Run the test again.</p>
              ) : null}
              <button type="button" className="btn btn-primary w-full" disabled={busy || !canApply} onClick={apply}>Apply the {kept.length} kept change{kept.length === 1 ? '' : 's'}</button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
