import { useEffect, useState } from 'react';
import { CircleHelp, Pause, Play, Rewind, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { ProgressBar } from './JobStatus.jsx';

// Replay: run the whole app on a recorded past day. The replay is a second copy of the server on its own port with its own paper
// account, so nothing here touches the real paper history. This file has the banner shown inside a replay and the Account card that starts one.

export const TOOLS_KEY = 'npt_replay_tools';
export const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
export const dayText = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export const replayToolsOn = () => {
  try {
    return localStorage.getItem(TOOLS_KEY) !== 'off';
  } catch {
    return true;
  }
};

/** The status of this server: 'live', or a replay with its clock. Polls while in a replay so the clock moves. */
export function useReplayStatus() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let alive = true;
    let timer;
    let prev = null;
    let inReplay = false;
    const load = () => {
      // a phone with the app in the background: do not ask, look again soon (and do not count the gap in the real speed)
      if (document.hidden && inReplay) {
        prev = null;
        timer = setTimeout(load, 3000);
        return;
      }
      api('/replay-day/status')
        .then((d) => {
          if (!alive) return;
          // the real speed: virtual seconds per real second since the last look (lower than chosen when the computer cannot keep up)
          const at = Date.now();
          if (d.mode === 'replay' && prev && !d.paused && at > prev.at) d.realSpeed = Math.round((d.virtualNow - prev.virtualNow) / (at - prev.at));
          prev = { at, virtualNow: d.virtualNow };
          inReplay = d.mode === 'replay';
          setS(d);
          if (d.mode === 'replay') timer = setTimeout(load, 1500); // the clock only moves in a replay
        })
        .catch(() => {
          // a dropped answer must not freeze the banner: inside a replay keep asking
          if (alive && inReplay) timer = setTimeout(load, 3000);
        });
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return s;
}

const DOT = { bad: 'bg-down', warn: 'bg-warn', ok: 'bg-up' };

/** A list of plain-words findings: a coloured dot and one sentence each. */
export function Findings({ items }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-xs leading-snug">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[it.level] ?? 'bg-muted'}`} aria-hidden="true" />
          <span className={it.level === 'ok' ? 'text-muted' : ''}>{it.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Why no trades?": what the bots see right now in this replay, refreshed every few seconds while open. */
function WhyPanel() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let timer;
    const load = () =>
      api('/replay-day/why')
        .then((d) => alive && (setItems(d.items), setError('')))
        .catch((e) => alive && setError(e.message))
        .finally(() => alive && (timer = setTimeout(load, 5000)));
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="mx-auto mt-2 max-w-5xl rounded-xl border border-line bg-surface p-3">
      <div className="mb-2 text-xs font-semibold">Why no trades? (red = blocks buying, yellow = worth a look)</div>
      {error && <p className="text-xs text-down">{error}</p>}
      {!items && !error ? <p className="text-xs text-muted">Checking…</p> : items && <Findings items={items} />}
    </div>
  );
}

/** How far the replayed day is: share of 09:15-15:30 played, and real time left at the speed it really runs. */
export function dayProgress(s) {
  if (!s?.startMs || !s?.endMs || s.endMs <= s.startMs) return null;
  const pct = Math.min(100, Math.max(0, ((s.virtualNow - s.startMs) / (s.endMs - s.startMs)) * 100));
  const leftVirtual = Math.max(0, (s.endMs - s.virtualNow) / 1000); // market seconds still to play
  const pace = s.realSpeed > 0 ? s.realSpeed : s.speed || 1;
  return { pct, leftVirtual, leftReal: leftVirtual / pace };
}

const hm = (sec) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
};

/** A speed button. 100x and 200x carry a small warning while no speed check has passed (they may give other trades than 50x). */
export function SpeedButton({ x, on, unchecked, disabled, onClick, className = '' }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`btn btn-sm relative shrink-0 ${on ? 'btn-primary' : 'btn-secondary'} ${className}`}
      title={unchecked ? 'Not checked yet: run "Check 200x" in the live app (More > Replay) to see it gives the same trades as 50x' : undefined}
    >
      {x}x
      {unchecked && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border border-bg bg-warn" aria-label="not checked" />}
    </button>
  );
}

/** Shown on every screen of a replay: it says so loudly, shows the virtual time and how much of the day is done, and holds pause and speed. */
export function ReplayBanner() {
  const s = useReplayStatus();
  const [resetting, setResetting] = useState(false);
  const [why, setWhy] = useState(false);
  if (s?.mode !== 'replay') return null;
  // The live app restarts this copy, so wait for it to go down and come back, then reload onto the fresh day.
  async function reset() {
    if (!window.confirm('Start this day again from the beginning? The test account (trades, orders) is wiped.')) return;
    setResetting(true);
    try {
      await api('/replay-day/reset', { method: 'POST' });
    } catch (e) {
      if (e.code !== 'NETWORK') {
        toast.error(e.message);
        setResetting(false);
        return;
      }
      // the copy was stopped while answering: it is restarting, keep waiting below
    }
    // wait until a NEW copy answers (its boot id differs), then reload onto the fresh day
    for (let i = 0; i < 160; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const st = await api('/replay-day/status');
        if (st.mode === 'replay' && st.bootId !== s.bootId) break;
      } catch {
        /* still restarting */
      }
    }
    window.location.reload();
  }
  const control = (body) => api('/replay-day/control', { method: 'POST', body }).catch((e) => toast.error(e.message));
  const live = `${window.location.protocol}//${window.location.hostname}:${s.livePort}/`;
  const prog = dayProgress(s);
  const unchecked = s.unchecked ?? [];
  const fastPicked = unchecked.includes(s.speed);
  return (
    <div className="sticky top-0 z-50 border-b-2 border-warn bg-[color-mix(in_srgb,var(--warn)_14%,var(--bg))] px-3 py-2 text-xs" role="status">
      <div className="mx-auto max-w-5xl space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="rounded-md bg-warn px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-black">Replay</span>
          <span className="font-semibold">
            {dayText(s.day)} · <span className="num">{clock(s.virtualNow)}</span> IST
          </span>
          {s.finished ? <span className="font-semibold text-up">Day finished</span> : s.paused ? <span className="font-semibold text-warn">Paused</span> : null}
          {!s.finished && !s.paused && s.realSpeed > 0 && (
            <span className="num text-muted" title="How fast the day really moves. Lower than the chosen speed when the computer is busy: nothing is skipped, it just runs slower.">
              real {s.realSpeed}x
            </span>
          )}
        </div>
        {prog && (
          <div>
            <ProgressBar pct={prog.pct} barClass={s.finished ? 'bg-up' : 'bg-warn'} />
            <div className="num mt-1 flex justify-between gap-2 text-[11px] text-muted">
              <span>{Math.floor(prog.pct)}% of the day played (09:15 to 15:30)</span>
              {!s.finished && <span>{s.paused ? `${hm(prog.leftVirtual)} of market left` : `about ${hm(prog.leftReal)} left`}</span>}
            </div>
          </div>
        )}
        {/* pause and every speed in one row that always fits the screen width (never widens the page on a phone) */}
        <div className="grid grid-cols-[auto_repeat(8,minmax(0,1fr))] gap-1 pt-1">
          <button type="button" className="btn btn-secondary btn-sm !px-2" disabled={s.finished} onClick={() => control({ paused: !s.paused })} aria-label={s.paused ? 'Resume' : 'Pause'}>
            {s.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          {s.speeds.map((x) => (
            <SpeedButton key={x} x={x} on={s.speed === x} unchecked={unchecked.includes(x)} disabled={s.finished} onClick={() => control({ speed: x })} className="!px-0 text-[11px]" />
          ))}
        </div>
        {fastPicked && <p className="text-[11px] text-warn">{s.speed}x is not checked yet: trades may differ from 50x. Run "Check 200x" in the live app (More &gt; Replay) to be sure.</p>}
        <div className="flex flex-wrap gap-1">
          <button type="button" className={`btn btn-sm ${why ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setWhy(!why)} title="Why has it not bought anything?">
            <CircleHelp className="h-3.5 w-3.5" /> Why no trades?
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={resetting} onClick={reset} title="Start this day again from 09:15 with an empty test account">
            <RotateCcw className={`h-3.5 w-3.5 ${resetting ? 'animate-spin' : ''}`} /> {resetting ? 'Restarting the day…' : 'Reset'}
          </button>
          {s.livePort ? (
            <a href={live} className="btn btn-secondary btn-sm ml-auto">
              <Rewind className="h-3.5 w-3.5" /> Back to live
            </a>
          ) : null}
        </div>
      </div>
      {why && <WhyPanel />}
    </div>
  );
}
