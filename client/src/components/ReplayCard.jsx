import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, tokenStore } from '../lib/api.js';
import { Card, Switch as AutoSwitch } from './ui.jsx';
import { JobStatus, LoadState } from './JobStatus.jsx';
import { Findings, SpeedButton, TOOLS_KEY, dayText, replayToolsOn } from './Replay.jsx';

// The More-page card that starts a replay of a saved day, and the 100x / 200x speed check. The banner inside a running replay is in Replay.jsx.

const SPEEDS = [1, 2, 5, 10, 25, 50, 100, 200];
const FAST = [100, 200]; // shown with a warning until a speed check found the same trades as 50x

/** Account card: choose a recorded day and a speed, start the replay, open it. */
export function ReplayCard() {
  const [tools, setTools] = useState(replayToolsOn());
  const [days, setDays] = useState(null);
  const [daysError, setDaysError] = useState('');
  const [day, setDay] = useState('');
  const [speed, setSpeed] = useState(10);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inReplay, setInReplay] = useState(false);
  const [check, setCheck] = useState(null);
  const [checkError, setCheckError] = useState('');
  const [seconds, setSeconds] = useState(false);
  const [unchecked, setUnchecked] = useState(FAST);
  const [speedCheck, setSpeedCheck] = useState(null);

  const loadDays = useCallback(() => {
    setDays(null);
    setDaysError('');
    return api('/replay-day/days')
      .then((d) => (setDays(d.days), setDay((cur) => cur || d.days[0]?.day || ''), d.unchecked && setUnchecked(d.unchecked)))
      .catch((e) => setDaysError(e.message || 'No answer from the server'));
  }, []);

  useEffect(() => {
    if (!tools) return undefined;
    let alive = true;
    api('/replay-day/status').then((d) => alive && (setInReplay(d.mode === 'replay'), setRun(d.run ?? null), d.unchecked && setUnchecked(d.unchecked), setSpeedCheck(d.speedCheck ?? null))).catch(() => {});
    loadDays();
    return () => {
      alive = false;
    };
  }, [tools, loadDays]);

  // what the chosen day lacks
  const [checkTry, setCheckTry] = useState(0);
  useEffect(() => {
    if (!tools || inReplay || !day) return undefined;
    let alive = true;
    setCheck(null);
    setCheckError('');
    api(`/replay-day/check?day=${day}`).then((d) => alive && setCheck(d.items)).catch((e) => alive && setCheckError(e.message || 'No answer from the server'));
    return () => {
      alive = false;
    };
  }, [tools, inReplay, day, checkTry]);

  // while it starts, ask until it is ready
  useEffect(() => {
    if (run?.state !== 'starting') return undefined;
    const t = setInterval(() => api('/replay-day/status').then((d) => setRun(d.run)).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [run?.state]);

  // while the speed check plays, ask every few seconds
  useEffect(() => {
    if (speedCheck?.state !== 'running') return undefined;
    const t = setInterval(
      () =>
        api('/replay-day/status')
          .then((d) => (setSpeedCheck(d.speedCheck ?? null), d.unchecked && setUnchecked(d.unchecked)))
          .catch(() => {}),
      5000,
    );
    return () => clearInterval(t);
  }, [speedCheck?.state]);

  async function checkSpeed(stopIt = false) {
    try {
      setSpeedCheck(await api(stopIt ? '/replay-day/speed-check/stop' : '/replay-day/speed-check', { method: 'POST', body: stopIt ? {} : { day } }));
    } catch (e) {
      toast.error(e.message);
    }
  }

  const toggle = () => {
    const next = !tools;
    setTools(next);
    try {
      localStorage.setItem(TOOLS_KEY, next ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
  };

  const chosen = days?.find((d) => d.day === day);
  async function start() {
    setBusy(true);
    try {
      setRun((await api('/replay-day/start', { method: 'POST', body: { day, speed, seconds: Boolean(seconds && chosen?.seconds) } })).run);
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
  const fastPicked = unchecked.includes(speed);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Replay a past day</div>
          <div className="text-xs text-muted">Test with the market closed: the app runs a full saved day on its 1-minute candles.</div>
        </div>
        <AutoSwitch on={tools} label="Replay tools" onClick={toggle} />
      </div>
      {tools && inReplay && <p className="mt-3 text-xs text-muted">This is a replay. Use Back to live in the yellow bar to go back to the live app and start another.</p>}
      {tools && !inReplay && (
        <div className="mt-3 space-y-3">
          {days == null ? (
            <LoadState loading={!daysError} error={daysError} onRetry={loadDays} what="saved days" />
          ) : days.length === 0 ? (
            <p className="text-xs text-muted">No saved day yet. Candles and option prices are saved each evening after the market closes.</p>
          ) : (
            <>
              <label className="block text-xs text-muted">
                Day
                <select className="field mt-1 !py-2" value={day} onChange={(e) => setDay(e.target.value)} disabled={run?.state === 'starting' || run?.state === 'ready'}>
                  {days.map((d) => (
                    <option key={d.day} value={d.day}>
                      {dayText(d.day)} ({d.day}){d.seconds ? ' · 1-sec too' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {chosen?.seconds && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
                  <div className="text-xs">
                    <div className="font-semibold">Use 1-second data</div>
                    <div className="text-muted">This day also has the 1-second record of the Nifty and the streamed options. Off: 1-minute candles, the same as every other day.</div>
                  </div>
                  <AutoSwitch on={seconds} label="Use 1-second data" onClick={() => setSeconds(!seconds)} />
                </div>
              )}
              <div className="rounded-xl border border-line p-3">
                <div className="mb-2 text-xs font-semibold">Replay data check for this day</div>
                {check ? <Findings items={check} /> : <LoadState loading={!checkError} error={checkError} onRetry={() => setCheckTry((n) => n + 1)} what="data check" />}
              </div>
              <div>
                <div className="mb-1 text-xs text-muted">Speed</div>
                <div className="grid grid-cols-4 gap-1.5">
                  {SPEEDS.map((x) => (
                    <SpeedButton key={x} x={x} on={speed === x} unchecked={unchecked.includes(x)} onClick={() => setSpeed(x)} className="w-full" />
                  ))}
                </div>
                {fastPicked && <p className="mt-1.5 text-[11px] text-warn">{speed}x is not checked yet: it may give other trades than 50x. Run the speed check below first to be sure.</p>}
                <div className="mt-1 text-[11px] text-muted">The market day is 6¼ hours: 10x takes about 38 minutes, 50x about 8, 200x about 2 if the computer keeps up. Nothing is skipped at any speed: every second plays in order, a busy computer just runs slower. You can change the speed during the replay.</div>
              </div>
              <SpeedCheckBox c={speedCheck} day={day} onStart={() => checkSpeed(false)} onStop={() => checkSpeed(true)} />
              {run?.state === 'starting' && <JobStatus state="running" title={`Getting ${dayText(run.day)} ready`} step="Starting the replay copy of the app. This takes up to a minute." startedAt={run.startedAt} onStop={stop} />}
              {run?.state === 'failed' && <JobStatus state="failed" title="The replay did not start" error={run.error} onRetry={start} />}
              {run?.state === 'ready' && <JobStatus state="done" title={`Replay of ${dayText(run.day)} is ready`} />}
              <div className="flex gap-2">
                {run?.state === 'ready' ? (
                  <button type="button" className="btn btn-primary flex-1" onClick={open}>
                    Open replay of {dayText(run.day)}
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary flex-1" disabled={busy || !day || run?.state === 'starting'} onClick={start}>
                    {busy ? 'Starting…' : 'Start replay'}
                  </button>
                )}
                {run?.state === 'ready' && (
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={stop}>
                    Stop
                  </button>
                )}
              </div>
              <p className="text-[11px] leading-snug text-muted">Replay trades live in a separate test account and are wiped each time you start a replay. Your real paper history is never touched. On 1-minute candles each minute plays as open, low/high, close, so a stop is reached before a target inside a minute (the careful guess).</p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

const mins = (sec) => (sec >= 90 ? `${Math.round(sec / 60)} min` : `${sec} s`);

/** The speed check: one day at 200x and at 50x with the settings now, every trade compared. Until it passes, 100x and 200x carry a warning. */
function SpeedCheckBox({ c, day, onStart, onStop }) {
  const state = c?.state ?? 'idle';
  return (
    <div className="space-y-2 rounded-xl border border-line p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Speed check for 100x / 200x</div>
        {state !== 'running' && (
          <button type="button" className="btn btn-secondary btn-sm shrink-0" disabled={!day} onClick={onStart}>
            Check 200x on {day ? dayText(day) : 'this day'}
          </button>
        )}
      </div>
      {state === 'idle' && <p className="text-muted">Plays the chosen day at 200x and at 50x with your settings now (1-minute candles) and compares every trade: time, side, price, exit and P&amp;L. Until a check passes, 100x and 200x show a yellow dot. Takes about 10 minutes.</p>}
      {state === 'running' && <JobStatus state="running" title="Speed check" step={c.step} startedAt={c.startedAt} onStop={onStop} note="Two plays of the day: first 200x, then 50x. You can leave this page." />}
      {state === 'failed' && <JobStatus state="failed" title="Speed check" error={c.error} onRetry={onStart} />}
      {state === 'done' && c.same && (
        <JobStatus
          state="done"
          title={`Same trades at 200x as at 50x on ${dayText(c.day)}`}
          step={`${c.runs?.[0]?.trades ?? 0} trade(s). 100x and 200x are checked. 50x took ${mins(c.runs?.[0]?.seconds ?? 0)}, 200x took ${mins(c.runs?.[1]?.seconds ?? 0)}: ${mins(Math.max(c.savedSeconds ?? 0, 0))} saved per day.`}
        />
      )}
      {state === 'done' && !c.same && (
        <div className="rounded-xl border border-down/40 bg-down-soft p-3 text-down">
          <p className="font-semibold">Trades differ at 200x on {dayText(c.day)}. 100x and 200x can be picked but may show other trades: use 50x or slower for results you rely on.</p>
          <ul className="mt-1 list-disc pl-4">
            {(c.diffs ?? []).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
