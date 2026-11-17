import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, Check, Play, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { istStamp } from '../../lib/study.js';
import { LEARN_DAYS, loadErrorText, runningText, applyState, compareRows, diffWord, groupChanges, splitLine, verdictBox, windowTitle, trackLine } from '../../lib/learn.js';
import { Badge, Card, Fold, Segmented, Sheet, Skeleton } from '../ui.jsx';
import { Switch } from '../options/OptionsAutoCard.jsx';
import { ComboLearn } from './ComboLearn.jsx';

const MODES = [
  { value: 'combos', label: 'Each combination' },
  { value: 'setup', label: 'Whole setup' },
];

/** How the results you applied did on the days after you applied them: the honest test of the learner, filled in by each later run. */
function TrackRecord({ track }) {
  if (!track?.length) return null;
  return (
    <Card className="space-y-2 p-3">
      <h3 className="text-sm font-semibold">Since you applied it</h3>
      <p className="text-[11px] text-muted">Each run replays what you applied against what you had before, on the days after you applied it. Those days were never learned on.</p>
      {track.map((t) => {
        const d = (t.new?.net ?? 0) - (t.old?.net ?? 0);
        return (
          <div key={t.key} className="border-t border-line pt-1.5 text-[11px] first:border-0 first:pt-0">
            <div className="flex justify-between gap-2">
              <span className="truncate font-semibold">{t.name}{t.forced ? ' (applied anyway)' : ''}</span>
              <Badge tone={d > 0 ? 'up' : d < 0 ? 'down' : 'muted'}>{diffWord(t.new?.net, t.old?.net)}</Badge>
            </div>
            <p className="text-muted">{trackLine(t)}</p>
          </div>
        );
      })}
    </Card>
  );
}

const stamp = (iso) => istStamp(Date.parse(iso) / 1000);
const BOX = { up: 'border-up bg-up-soft', down: 'border-down bg-down-soft', warn: 'border-warn bg-warn/10', muted: 'border-line bg-surface-2' };
const TEXT = { up: 'text-up', down: 'text-down', warn: 'text-warn', muted: 'text-fg' };
const ACTION = { started: 'Started', learned: 'Learned', 'learned combos': 'Learned each combination', failed: 'Failed to run', applied: 'Applied', 'applied anyway': 'Applied anyway', undone: 'Undone' };

/** Old against new, one row per measure; the better side of a row is green, the worse red. */
function Compare({ part, title }) {
  const rows = compareRows(part);
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      {title && <div className="text-xs font-semibold">{title}</div>}
      <div className="overflow-hidden rounded-lg border border-line text-[11px]">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 bg-surface-2 px-2 py-1 font-semibold text-muted">
          <span />
          <span className="w-20 text-right">Old</span>
          <span className="w-20 text-right">New</span>
        </div>
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-t border-line px-2 py-1">
            <span className="text-muted">{r.label}</span>
            <span className="num w-20 text-right">{r.old}</span>
            <span className={`num w-20 text-right font-semibold ${r.better ? 'text-up' : r.worse ? 'text-down' : ''}`}>{r.new}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Lab > Learn: tries changes to the options settings on the saved days, hides the newest days, and replays old against new on them. */
export function LearnLab() {
  const [view, setView] = useState(null);
  const [days, setDays] = useState('30');
  const [mode, setMode] = useState('combos');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      setView(await api('/lab/learn'));
      setLoadError(null);
    } catch (e) {
      setLoadError(loadErrorText(e));
    }
  }, []);

  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, [load]);

  const running = view?.status?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    timer.current = setTimeout(load, 2000);
    return () => clearTimeout(timer.current);
  }, [running, view, load]);

  async function act(path, body, done) {
    setBusy(true);
    try {
      const next = await api(`/lab/learn${path}`, { method: 'POST', body });
      if (next?.status && next.last !== undefined) setView(next);
      else await load();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(e.message || 'Could not do that');
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }

  const last = view?.last;
  const box = verdictBox(last);
  const can = applyState(last);
  const showResult = last && !['short', 'error'].includes(last.verdict) && last.split;

  return (
    <div className="space-y-3">
      <Card className="space-y-2.5 p-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Brain className="h-4 w-4 text-accent" /> Learn better settings (Nifty options)
        </h2>
        <Segmented className="w-full" size="sm" value={days} onChange={setDays} options={LEARN_DAYS} />
        <Segmented className="w-full" size="sm" value={mode} onChange={setMode} options={MODES} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] leading-snug text-muted"><b className="text-fg">Learn every evening</b> (after 17:00 on trading days, 30 days, both kinds). It only suggests; nothing is applied without your tap.</span>
          <Switch on={Boolean(view?.evening)} label="Learn every evening" disabled={busy || !view} onClick={() => act('/evening', { on: !view?.evening }, view?.evening ? 'Evening learning off.' : 'Evening learning on.')} />
        </div>
        {running && <p className="text-[11px] leading-snug text-accent" role="status">{runningText(view.status)}</p>}
        {view?.interrupted && !running && <p className="text-[11px] leading-snug text-warn">{view.interrupted}</p>}
        {view?.simulated && <p className="text-[11px] text-warn">The app is on the practice feed: its candles are made up, so a result here means nothing for real trading.</p>}
      </Card>

      {loadError && (
        <Card className="space-y-2 border-down p-3">
          <p className="text-xs text-down">{loadError}</p>
          <button type="button" className="btn btn-secondary btn-sm w-full" onClick={load}>Try again</button>
        </Card>
      )}
      {!view && !loadError && <Skeleton className="h-48 w-full" />}
      {mode === 'combos' && <ComboLearn view={view} days={days} busy={busy} running={running} act={act} />}
      {mode === 'combos' && <TrackRecord track={view?.track} />}

      {mode === 'setup' && (
      <>
      <Card className="space-y-2.5 p-3">
        <p className="text-[11px] leading-snug text-muted">
          It tries changes to your whole setup on the saved days (changes that passed before are tried first, and a change must help through most of the learning days, not one lucky day): which combinations are on and on which side, an extra indicator on a combination (RSI, MACD, EMA, VWAP, Bollinger, ATR, Supertrend, ADX, or PCR, IV percentile, OI change, max pain, delta and theta), trades a day and loss limits, the stop, the profit ladder and the entry hours. It keeps the <b className="text-fg">newest days (about 1 in 4) hidden</b> while it learns, then replays your old and the new settings on them. It judges on <b className="text-fg">steady profit</b>: fewer and smaller losing days and a better win/loss ratio, not only the total.
        </p>
        <button type="button" className="btn btn-secondary w-full" disabled={running || busy || !view} onClick={() => act('/run', { days: Number(days), what: 'setup' })}>
          <Play className="h-4 w-4" /> {running ? 'Learning…' : 'Learn now (a few minutes)'}
        </button>
      </Card>

      {view && !last && !running && <p className="px-1 text-xs text-muted">Not run yet. Pick how many saved days to use and tap Learn now.</p>}

      {last && box && (
        <div className={`space-y-2 rounded-2xl border-2 p-3 ${BOX[box.tone]}`} role="status">
          <div className="flex items-center justify-between gap-2">
            <span className={`flex items-center gap-1.5 text-base font-bold ${TEXT[box.tone]}`}>
              {box.tone === 'up' ? <Check className="h-5 w-5" /> : box.tone === 'down' ? <X className="h-5 w-5" /> : null}
              {box.title}
            </span>
            <span className="text-[11px] text-muted">{stamp(last.at)}</span>
          </div>
          <p className="text-xs leading-snug">{last.text}</p>
          {last.checks?.length > 0 && (
            <ul className="space-y-0.5 text-[11px]">
              {last.checks.map((c) => (
                <li key={c.key} className="flex items-start gap-1.5">
                  {c.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-up" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-down" />}
                  <span>Hidden days: {c.text}</span>
                </li>
              ))}
            </ul>
          )}
          {can.action === 'apply' && (
            <button type="button" className="btn btn-primary w-full" disabled={busy || running} onClick={() => act('/apply', { force: false }, 'Applied to your paper options settings.')}>
              Apply these settings
            </button>
          )}
          {can.action === 'confirm' && (
            <div className="space-y-1.5">
              <button type="button" className="btn btn-secondary w-full" disabled aria-disabled="true">Apply (blocked: failed on the hidden days)</button>
              <button type="button" className="btn btn-outline-down btn-sm w-full" disabled={busy || running} onClick={() => setAsking(true)}>Apply anyway…</button>
            </div>
          )}
          {can.why && <p className="text-[11px] text-muted">{can.why}</p>}
          {last.canUndo && (
            <button type="button" className="btn btn-secondary btn-sm w-full" disabled={busy || running} onClick={() => act('/undo', undefined, 'Your old settings are back.')}>
              <Undo2 className="h-4 w-4" /> Undo: put my old settings back
            </button>
          )}
        </div>
      )}

      {last?.notes?.length > 0 && (
        <div className="space-y-1 px-1">
          {last.notes.map((n) => <p key={n} className="text-[11px] text-warn">{n}</p>)}
        </div>
      )}

      {showResult && (
        <>
          {last.changes.length > 0 && (
            <Card className="space-y-2 p-3">
              <h3 className="text-sm font-semibold">What it would change ({last.changes.length})</h3>
              {groupChanges(last.changes).map(({ group, list }) => (
                <div key={group} className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{group}</div>
                  {list.map((c, n) => (
                    <div key={`${c.label}-${n}`} className="rounded-lg bg-surface-2 p-2 text-[11px] leading-snug">
                      <div className="font-semibold">{c.label}</div>
                      <div className="text-muted">
                        {c.from} → <span className="text-fg">{c.to}</span> · steadier by ₹{Math.round(c.gain).toLocaleString('en-IN')} a day on the learning days
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </Card>
          )}

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">Hidden days: old against new</h3>
            <p className="text-[11px] text-muted">The newest {last.split.hiddenDays} days ({last.split.hiddenFrom} to {last.split.to}). It never saw them while learning, so this is the fair test.</p>
            <Compare part={last.hidden} />
          </Card>

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">Last 5, 10 and 15 days</h3>
            <p className="text-[11px] text-muted">Longer windows include days it learned on, so they flatter the new settings. The hidden days are the honest part.</p>
            {last.windows.map((w) => (
              <div key={w.days} className="space-y-1 border-t border-line pt-2 first:border-0 first:pt-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold">{windowTitle(w)}</span>
                  <Badge tone={w.new.net > w.old.net ? 'up' : w.new.net < w.old.net ? 'down' : 'muted'}>{diffWord(w.new.net, w.old.net)}</Badge>
                </div>
                <Compare part={w} />
              </div>
            ))}
          </Card>

          <Fold id="learn-learning-days" title="Learning days: old against new" summary={`The ${last.split.learnDays} days it learned on (these always look better)`}>
            <Compare part={last.learn} />
          </Fold>
          <p className="px-1 text-[11px] leading-snug text-muted">{splitLine(last)}</p>
        </>
      )}

      <TrackRecord track={view?.track} />
      </>
      )}

      {view?.log?.length > 0 && (
        <Fold id="learn-log" title="History" summary="Each run, apply and undo">
          <div className="space-y-1.5">
            {view.log.map((e, n) => (
              <div key={`${e.at}-${n}`} className="border-t border-line pt-1.5 text-[11px] first:border-0 first:pt-0">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">{ACTION[e.action] ?? e.action}</span>
                  <span className="text-muted">{stamp(e.at)}</span>
                </div>
                <p className="text-muted">{e.text}</p>
              </div>
            ))}
          </div>
        </Fold>
      )}

      {view?.note && <p className="px-1 text-[11px] leading-snug text-muted">{view.note}</p>}

      {asking && last && (
        <Sheet title="Apply anyway?" subtitle="These settings failed on the hidden days" onClose={() => setAsking(false)}>
          <div className="space-y-3 pt-2 text-xs leading-snug">
            <p>On the newest {last.split?.hiddenDays} days, which the learner never saw, the new settings did not beat your current ones:</p>
            <ul className="space-y-0.5">
              {last.checks?.filter((c) => !c.ok).map((c) => (
                <li key={c.key} className="flex items-start gap-1.5"><X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-down" /> {c.text}</li>
              ))}
            </ul>
            <p className="text-muted">That usually means the changes fit the past days and not the market. It changes your paper settings only, and Undo puts the old ones back.</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setAsking(false)}>Cancel</button>
              <button type="button" className="btn btn-sell" disabled={busy} onClick={() => act('/apply', { force: true }, 'Applied anyway. Undo is below the result.')}>Yes, apply anyway</button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
