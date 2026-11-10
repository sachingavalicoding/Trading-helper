import { useEffect, useState } from 'react';
import { CircleHelp, Pause, Play, Rewind, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api, tokenStore } from '../lib/api.js';
import { Card } from './ui.jsx';
import { Switch as AutoSwitch } from './options/OptionsAutoCard.jsx';

// Replay: run the whole app on a recorded past day. The replay is a second copy of the server on its own port with its own paper
// account, so nothing here touches the real paper history. This file has the banner shown inside a replay and the Account card that starts one.

const TOOLS_KEY = 'npt_replay_tools';
const SPEEDS = [1, 2, 5, 10, 25, 50];
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
const dayText = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

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
    const load = () =>
      api('/replay-day/status')
        .then((d) => {
          if (!alive) return;
          setS(d);
          if (d.mode === 'replay') timer = setTimeout(load, 1500); // the clock only moves in a replay
        })
        .catch(() => {});
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
function Findings({ items }) {
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

/** Shown on every screen of a replay: it says so loudly, shows the virtual time, and holds pause and speed. */
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
  return (
    <div className="sticky top-0 z-50 border-b-2 border-warn bg-warn/15 px-3 py-2 text-xs backdrop-blur" role="status">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="rounded-md bg-warn px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-black">Replay mode</span>
        <span className="font-semibold">{dayText(s.day)} · <span className="num">{clock(s.virtualNow)}</span> IST{s.finished ? ' · day finished' : ''}</span>
        <span className="text-muted">Test paper account, not your real trades.</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="btn btn-secondary btn-sm" disabled={s.finished} onClick={() => control({ paused: !s.paused })} aria-label={s.paused ? 'Resume' : 'Pause'}>
            {s.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          {s.speeds.map((x) => (
            <button key={x} type="button" disabled={s.finished} onClick={() => control({ speed: x })} className={`btn btn-sm ${s.speed === x ? 'btn-primary' : 'btn-secondary'}`}>
              {x}x
            </button>
          ))}
          <button type="button" className={`btn btn-sm ${why ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setWhy(!why)} title="Why has it not bought anything?">
            <CircleHelp className="h-3.5 w-3.5" /> Why no trades?
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={resetting} onClick={reset} title="Start this day again from 09:15 with an empty test account">
            <RotateCcw className="h-3.5 w-3.5" /> {resetting ? 'Resetting…' : 'Reset'}
          </button>
          {s.livePort ? (
            <a href={live} className="btn btn-secondary btn-sm ml-1">
              <Rewind className="h-3.5 w-3.5" /> Live
            </a>
          ) : null}
        </div>
      </div>
      {why && <WhyPanel />}
    </div>
  );
}

/** Account card: choose a recorded day and a speed, start the replay, open it. */
export function ReplayCard() {
  const [tools, setTools] = useState(replayToolsOn());
  const [days, setDays] = useState(null);
  const [day, setDay] = useState('');
  const [speed, setSpeed] = useState(10);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inReplay, setInReplay] = useState(false);
  const [check, setCheck] = useState(null);

  useEffect(() => {
    if (!tools) return undefined;
    let alive = true;
    api('/replay-day/status').then((d) => alive && (setInReplay(d.mode === 'replay'), setRun(d.run ?? null))).catch(() => {});
    api('/replay-day/days').then((d) => alive && (setDays(d.days), setDay((cur) => cur || d.days[0]?.day || ''))).catch(() => alive && setDays([]));
    return () => {
      alive = false;
    };
  }, [tools]);

  // what the chosen day lacks
  useEffect(() => {
    if (!tools || inReplay || !day) return undefined;
    let alive = true;
    setCheck(null);
    api(`/replay-day/check?day=${day}`).then((d) => alive && setCheck(d.items)).catch(() => alive && setCheck([]));
    return () => {
      alive = false;
    };
  }, [tools, inReplay, day]);

  // while it starts, ask until it is ready
  useEffect(() => {
    if (run?.state !== 'starting') return undefined;
    const t = setInterval(() => api('/replay-day/status').then((d) => setRun(d.run)).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [run?.state]);

  const toggle = () => {
    const next = !tools;
    setTools(next);
    try {
      localStorage.setItem(TOOLS_KEY, next ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
  };

  async function start() {
    setBusy(true);
    try {
      setRun((await api('/replay-day/start', { method: 'POST', body: { day, speed } })).run);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    setBusy(true);
    try {
      setRun((await api('/replay-day/stop', { method: 'POST' })).run);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  const open = () => {
    // the replay is another address, so the login is passed along once in the link
    window.location.href = `${window.location.protocol}//${window.location.hostname}:${run.port}/#t=${encodeURIComponent(tokenStore.get() || '')}`;
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Replay a past day</div>
          <div className="text-xs text-muted">Test with the market closed: the app runs a full day on recorded 1-second data.</div>
        </div>
        <AutoSwitch on={tools} label="Replay tools" onClick={toggle} />
      </div>
      {tools && inReplay && <p className="mt-3 text-xs text-muted">This is a replay. Use Live in the yellow bar to go back to the live app and start another.</p>}
      {tools && !inReplay && (
        <div className="mt-3 space-y-3">
          {days == null ? (
            <p className="text-xs text-muted">Loading the recorded days…</p>
          ) : days.length === 0 ? (
            <p className="text-xs text-muted">No recorded seconds yet. They are saved while the live market is open (the newest 3 days are kept).</p>
          ) : (
            <>
              <label className="block text-xs text-muted">
                Day (only days with recorded seconds)
                <select className="field mt-1 !py-2" value={day} onChange={(e) => setDay(e.target.value)} disabled={run?.state === 'starting' || run?.state === 'ready'}>
                  {days.map((d) => (
                    <option key={d.day} value={d.day}>{dayText(d.day)} ({d.day})</option>
                  ))}
                </select>
              </label>
              <div className="rounded-xl border border-line p-3">
                <div className="mb-2 text-xs font-semibold">Replay data check for this day</div>
                {check == null ? <p className="text-xs text-muted">Checking what is saved…</p> : <Findings items={check} />}
              </div>
              <div>
                <div className="mb-1 text-xs text-muted">Speed</div>
                <div className="grid grid-cols-6 gap-1">
                  {SPEEDS.map((x) => (
                    <button key={x} type="button" onClick={() => setSpeed(x)} className={`btn btn-sm ${speed === x ? 'btn-primary' : 'btn-secondary'}`}>{x}x</button>
                  ))}
                </div>
                <div className="mt-1 text-[11px] text-muted">The market day is 6¼ hours: 10x takes about 38 minutes, 50x about 8. You can change the speed during the replay.</div>
              </div>
              {run?.state === 'starting' && <p className="text-xs text-muted">Getting the day ready… this takes up to a minute.</p>}
              {run?.state === 'failed' && <p className="text-xs text-down">{run.error}</p>}
              <div className="flex gap-2">
                {run?.state === 'ready' ? (
                  <button type="button" className="btn btn-primary flex-1" onClick={open}>Open replay of {dayText(run.day)}</button>
                ) : (
                  <button type="button" className="btn btn-primary flex-1" disabled={busy || !day || run?.state === 'starting'} onClick={start}>Start replay</button>
                )}
                {(run?.state === 'ready' || run?.state === 'starting') && <button type="button" className="btn btn-secondary" disabled={busy} onClick={stop}>Stop</button>}
              </div>
              <p className="text-[11px] leading-snug text-muted">Replay trades live in a separate test account and are wiped each time you start a replay. Your real paper history is never touched. Only Nifty and the option contracts that were streaming were recorded each second; shares move once a minute.</p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
