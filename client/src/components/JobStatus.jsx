import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleSlash, CircleX, LoaderCircle, RotateCcw, Square } from 'lucide-react';

// One way to show anything that loads or runs: what state it is in (Loading, Running, Failed, Skipped, Done), a progress bar,
// "x of y", how long it has run and, when the work reports how far it is, about how long is left. Used by Replay, Learn, the studies,
// Year test and the year-file download, so every long job looks and reads the same.

const LOOK = {
  loading: { word: 'Loading', icon: LoaderCircle, tone: 'text-accent', bar: 'bg-accent', spin: true },
  running: { word: 'Running', icon: LoaderCircle, tone: 'text-accent', bar: 'bg-accent', spin: true },
  failed: { word: 'Failed', icon: CircleX, tone: 'text-down', bar: 'bg-down' },
  skipped: { word: 'Skipped', icon: CircleSlash, tone: 'text-warn', bar: 'bg-warn' },
  done: { word: 'Done', icon: CircleCheck, tone: 'text-up', bar: 'bg-up' },
};

/** "3 of 12" or "(3/50)" inside a step text: the first one found, as numbers. */
export function stepCount(step) {
  const m = String(step ?? '').match(/(\d+)\s*(?:of|\/)\s*(\d+)/);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  return total > 0 && done <= total ? { done, total } : null;
}

/** Seconds as "45 s", "3 min 10 s", "1 h 05 min". */
export function took(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

/**
 * About how many seconds are left, from how fast `done` moved since this total was first seen. Only said once a few steps were made,
 * so an early guess is never shown as a promise. Resets when the total changes (a new part of the job started).
 */
export function useTimeLeft(done, total, active) {
  const seen = useRef(null);
  if (!active || !total || done == null) {
    seen.current = null;
    return null;
  }
  const now = Date.now();
  if (!seen.current || seen.current.total !== total || done < seen.current.done) seen.current = { total, done, at: now };
  const moved = done - seen.current.done;
  const secs = (now - seen.current.at) / 1000;
  if (moved < 2 || secs < 5) return null;
  return ((total - done) * secs) / moved;
}

/** Ticks every second while `on`, so "so far" moves between polls. */
function useSecondTick(on) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/**
 * state: 'loading' | 'running' | 'failed' | 'skipped' | 'done'. title: what is running. step: what it does now.
 * done/total: how far (else read from "x of y" in the step). startedAt: ms or ISO, for "so far". error: why it failed or was skipped.
 * onStop / onRetry: buttons. note: one small line under it. unit: the word after the count ("days", "months").
 */
export function JobStatus({ state = 'running', title, step, done, total, startedAt, seconds, error, onStop, onRetry, stopText = 'Stop', retryText = 'Try again', note, unit = '', className = '' }) {
  const look = LOOK[state] ?? LOOK.running;
  if (error && typeof error !== 'string') error = error.message || String(error); // an Error from useApi, or a plain text
  const active = state === 'running' || state === 'loading';
  useSecondTick(active && (startedAt != null || seconds != null));
  const counted = total ? { done: done ?? 0, total } : stepCount(step);
  const pct = counted ? Math.min(100, Math.round((counted.done / counted.total) * 100)) : state === 'done' ? 100 : null;
  const left = useTimeLeft(counted?.done, counted?.total, active);
  const start = startedAt != null ? new Date(startedAt).getTime() : null;
  const sofar = seconds != null ? seconds : start ? (Date.now() - start) / 1000 : null;
  const Icon = look.icon;
  const facts = [
    counted && `${counted.done} of ${counted.total}${unit ? ` ${unit}` : ''}`,
    pct != null && active && `${pct}%`,
    active && sofar != null && `${took(sofar)} so far`,
    active && left != null && `about ${took(left)} left`,
  ].filter(Boolean);
  return (
    <div className={`fade-in rounded-xl border border-line bg-surface-2/60 p-3 text-xs ${className}`} role="status" aria-live="polite">
      <div className="flex items-start gap-2">
        <Icon className={`mt-px h-4 w-4 shrink-0 ${look.tone} ${look.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={`font-semibold ${look.tone}`}>{look.word}</span>
            {title && <span className="font-semibold">{title}</span>}
          </div>
          {step && <div className="mt-0.5 break-words text-muted">{step}</div>}
          {error && <div className={`mt-0.5 break-words ${state === 'skipped' ? 'text-warn' : 'text-down'}`}>{error}</div>}
        </div>
        {active && onStop && (
          <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={onStop}>
            <Square className="h-3 w-3" /> {stopText}
          </button>
        )}
        {(state === 'failed' || state === 'skipped') && onRetry && (
          <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={onRetry}>
            <RotateCcw className="h-3 w-3" /> {retryText}
          </button>
        )}
      </div>
      {(active || pct != null) && state !== 'failed' && state !== 'skipped' && <ProgressBar pct={pct} className="mt-2" barClass={look.bar} />}
      {facts.length > 0 && <div className="num mt-1.5 text-[11px] text-muted">{facts.join(' · ')}</div>}
      {note && <div className="mt-1 text-[11px] text-muted">{note}</div>}
    </div>
  );
}

/** A thin bar. pct null = still working, amount unknown (a moving stripe). */
export function ProgressBar({ pct, className = '', barClass = 'bg-accent' }) {
  return (
    <div className={`relative h-1.5 overflow-hidden rounded-full bg-surface-3 ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      {pct == null ? <div className={`progress-indeterminate absolute inset-y-0 w-1/3 rounded-full ${barClass}`} /> : <div className={`h-full rounded-full transition-[width] duration-500 ease-out ${barClass}`} style={{ width: `${pct}%` }} />}
    </div>
  );
}

/** For a plain fetch: a loading line, or the error with Try again. Renders nothing once loaded. */
export function LoadState({ loading, error, onRetry, what = 'data' }) {
  if (error) return <JobStatus state="failed" title={`Could not load the ${what}`} error={error} onRetry={onRetry} />;
  if (loading) return <JobStatus state="loading" title={`the ${what}`} />;
  return null;
}
