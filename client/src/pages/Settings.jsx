import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Clock, Hourglass, ListChecks, Shield, ShieldCheck, Target, Trash2, Plus, TrendingUp, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { DEFAULT_EXIT_MIN, MAX_ROWS, ladderLines, ladderSummary, minOfTime, nextRow, rowsFromRules, rowsProblem, stepsOf, timeText } from '../lib/ladder.js';
import { Fold, Segmented, Skeleton } from '../components/ui.jsx';
import { AutoLimits } from '../components/AutoCard.jsx';
import { OptionsLimits, SafetyRules, SpeedSettings, StopPlacement, Switch } from '../components/options/OptionsAutoCard.jsx';
import { TrailStop } from '../components/options/TrailStop.jsx';
import { ShareEntryRules } from '../components/study/ShareEntryRules.jsx';
import { STOP_MODES } from '../lib/stops.js';
import { SettingsTransfer } from '../components/SettingsTransfer.jsx';

const NUM = 'field num mt-1 !py-2';

/** One segment's stop and its profit ladder: a stop in rupees, then rows of "profit reaches X, the stop keeps Y" that you type. */
function RulesForm({ title, rules, onSave, onLock, saved, stopLabel = 'Stop loss (₹ a trade)', stopNote }) {
  const [draft, setDraft] = useState(null);
  const v = draft ?? { stopLoss: String(rules.stopLoss), rows: rowsFromRules(rules), exitTime: timeText(rules.exitMin ?? DEFAULT_EXIT_MIN) };
  const edit = (next) => setDraft({ ...v, ...next });
  const setRow = (i, k) => (e) => edit({ rows: v.rows.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)) });
  const problem = rowsProblem(v.rows);
  const exitMin = minOfTime(v.exitTime);
  const bad = !(Number(v.stopLoss) >= 0) || problem != null || exitMin == null;
  const steps = stepsOf(v.rows);
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold">{title}</div>
      <label className="block text-xs text-muted">
        {stopLabel}
        <input className={NUM} inputMode="numeric" value={v.stopLoss} onChange={(e) => edit({ stopLoss: e.target.value })} />
      </label>
      <label className="block text-xs text-muted">
        Close the auto trader's trades at (IST, 09:15 to 15:15)
        <input type="time" min="09:15" max="15:15" className={NUM} value={v.exitTime} onChange={(e) => edit({ exitTime: e.target.value })} />
      </label>
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-xs font-semibold">Profit lock (book profit)</div>
        <Switch on={rules.lockOn !== false} label={`${title} profit lock`} onClick={() => onLock(rules.lockOn === false)} />
      </div>
      {rules.lockOn === false && <p className="text-xs text-warn">Off: new trades have no profit lock, so a gain is not protected by the ladder. Your rows below are kept; switch it back on to use them.</p>}
      <div className={rules.lockOn === false ? 'space-y-2 opacity-50' : 'space-y-2'}>
      {v.rows.length === 0 ? (
        <p className="text-xs text-muted">No rows: no profit lock.</p>
      ) : (
        <div className="space-y-1.5">
          <div className="grid grid-cols-[1fr_1fr_2.25rem] gap-2 text-[11px] text-muted">
            <span>When the profit reaches (₹)</span>
            <span>The stop keeps (₹)</span>
            <span />
          </div>
          {v.rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_2.25rem] items-center gap-2">
              <input className={NUM.replace('mt-1 ', '')} inputMode="numeric" aria-label={`Row ${i + 1} profit`} value={r.at} onChange={setRow(i, 'at')} />
              <input className={NUM.replace('mt-1 ', '')} inputMode="numeric" aria-label={`Row ${i + 1} lock`} value={r.keep} onChange={setRow(i, 'keep')} />
              <button type="button" aria-label={`Remove row ${i + 1}`} onClick={() => edit({ rows: v.rows.filter((_, j) => j !== i) })} className="btn btn-ghost !p-1.5 text-muted">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {v.rows.length < MAX_ROWS && (
        <button type="button" onClick={() => edit({ rows: [...v.rows, nextRow(v.rows)] })} className="btn btn-secondary btn-sm w-full">
          <Plus className="h-4 w-4" /> Add a row
        </button>
      )}
      </div>
      {problem && <p className="text-xs text-down">{problem}</p>}
      <button type="button" disabled={bad || draft == null} onClick={async () => { if (await onSave({ stopLoss: Number(v.stopLoss), steps, exitMin })) setDraft(null); }} className="btn btn-primary w-full">
        {saved && draft == null ? 'Saved' : `Save ${title.toLowerCase()}`}
      </button>
      <div className="space-y-1 text-[11px] leading-snug text-muted">
        {rules.lockOn !== false && steps.length > 0 && !problem ? ladderLines(steps).map((l) => <p key={l.at}>{l.text}</p>) : null}
        {rules.lockOn !== false && steps.length > 0 && !problem && <p>The stop never moves back. When the profit reaches the next row, that row takes over.</p>}
        <p>{exitMin == null ? 'Enter a time from 09:15 to 15:15.' : `The auto trader closes its trades at ${v.exitTime} and takes no new one after it. The studies use this time too. A trade you place by hand is only closed by the 15:15 square-off.`}</p>
        <p>{stopNote ?? (Number(v.stopLoss) > 0 ? `Every trade starts with a stop that loses at most ₹${Number(v.stopLoss)}.` : 'No automatic stop.')}</p>
      </div>
    </div>
  );
}

const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

const clockOf = (min) => timeText(min);

/** Settings: the hours new auto trades may be taken (09:15 to 15:15 unless changed), for options (`/options`) or shares (`/auto`). */
function EntryHours({ data, reload, path = '/options', note = 'Applies to the bot, the studies, Review and the Lab alike, so a study shows what these hours would have done. Trades you open by hand, and the time the bot closes its trades, are not affected.' }) {
  const s = data.settings;
  const [from, setFrom] = useState(clockOf(s.entryFrom ?? 555));
  const [to, setTo] = useState(clockOf(s.entryTo ?? 915));
  const a = minOfTime(from);
  const b = minOfTime(to);
  const bad = a == null || b == null || a < 555 || b > 915 || a >= b;
  const changed = a !== (s.entryFrom ?? 555) || b !== (s.entryTo ?? 915);
  async function put() {
    try {
      await api(path, { method: 'PUT', body: { entryFrom: a, entryTo: b } });
      toast.success('Saved. New automatic trades use these hours.');
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    }
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          First entry (09:15 or later)
          <input type="time" min="09:15" max="15:14" className={NUM} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block text-xs text-muted">
          Last entry (up to 15:15)
          <input type="time" min="09:16" max="15:15" className={NUM} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {bad && <p className="text-xs text-down">Pick times between 09:15 and 15:15, the last one after the first.</p>}
      <button type="button" disabled={bad || !changed} onClick={put} className="btn btn-primary w-full">
        {changed ? 'Save entry hours' : 'Saved'}
      </button>
      <p className="text-[11px] leading-snug text-muted">{note}</p>
    </div>
  );
}


const SEG = 'settings.seg';
const remembered = () => {
  try {
    return localStorage.getItem(SEG) === 'shares' ? 'shares' : 'options';
  } catch {
    return 'options';
  }
};

const line = (r, stopWord) => `${r.stopLoss > 0 ? `${stopWord} ${rs(r.stopLoss)}` : 'no stop'} · ${r.lockOn === false ? 'profit lock off' : ladderSummary(r.steps)} · close ${timeText(r.exitMin ?? DEFAULT_EXIT_MIN)}`;
const hours = (s) => `${clockOf(s.entryFrom ?? 555)} to ${clockOf(s.entryTo ?? 915)}`;

/**
 * Settings: every setting of the two bots, in one place, one fold per subject. Options or Shares at the top.
 * What the bots buy on (combinations, patterns, setups) is on the Combos page; nothing here repeats it.
 */
export default function Settings() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('seg');
  const seg = asked === 'shares' || asked === 'options' ? asked : remembered();
  const pick = (v) => {
    try {
      localStorage.setItem(SEG, v);
    } catch {
      /* not remembered */
    }
    setParams({ seg: v }, { replace: true });
  };
  const rules = useApi('/trade-defaults', []);
  const options = useApi('/options', []);
  const auto = useApi('/auto', []);
  const [saved, setSaved] = useState('');

  const save = (key) => async (body) => {
    try {
      await api('/trade-defaults', { method: 'PUT', body: { [key]: body } });
      toast.success('Saved. New trades use this.');
      setSaved(key);
      rules.reload();
      options.reload();
      auto.reload();
      return true;
    } catch (e) {
      toast.error(e.message || 'Could not save');
      return false;
    }
  };
  const lock = (key) => async (on) => {
    try {
      await api('/trade-defaults', { method: 'PUT', body: { [key]: { lockOn: on } } });
      toast.success(on ? 'Profit lock on for new trades.' : 'Profit lock off for new trades.');
      rules.reload();
      options.reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    }
  };

  const r = rules.data;
  const o = options.data;
  const a = auto.data;
  return (
    <div className="space-y-3">
      <h1 className="px-1 text-lg font-bold">Settings</h1>
      <Segmented className="w-full" value={seg} onChange={pick} options={[{ value: 'options', label: 'Options bot' }, { value: 'shares', label: 'Shares bot' }]} />
      <p className="px-1 text-[11px] leading-snug text-muted">One set of rules for auto and manual trades, used from the moment you save. A trade placed with its own stop keeps that stop. A combination with its own order settings (Combos) uses those instead.</p>

      {seg === 'options' && (
        <div className="space-y-2">
          <Fold id="set-o-stop" icon={Shield} title="Loss limit, profit lock, close time" summary={r ? line(r.options, 'loss limit') : 'Loading…'}>
            {r ? <RulesForm key={`o${JSON.stringify(r.options)}`} title="Options" rules={r.options} onSave={save('options')} onLock={lock('options')} saved={saved === 'options'} stopLabel="Most one trade may lose (₹)" stopNote={Number(r.options.stopLoss) > 0 ? `The bot sells when the Nifty chart level breaks, and buys only as many lots as keep that loss within ₹${r.options.stopLoss}. A hard stop sits behind it for a fast fall.` : 'No loss limit.'} /> : <Skeleton className="h-40" />}
          </Fold>
          <Fold id="set-o-stopplace" icon={Target} title="Where the stop goes" summary={o ? STOP_MODES.find((m) => m.value === o.settings.patternStopMode)?.label ?? 'Chart level' : 'Loading…'}>
            {o ? <StopPlacement data={o} reload={options.reload} /> : <Skeleton className="h-24" />}
          </Fold>
          <Fold id="set-o-trail" icon={TrendingUp} title="Trailing stop and break-even" summary={o ? (o.settings.trailMode && o.settings.trailMode !== 'off' ? `Trail ${o.settings.trailPoints} pts` : 'Trail off') + (o.settings.breakEvenPoints > 0 ? ` · break-even at ${o.settings.breakEvenPoints} pts` : '') : 'Loading…'}>
            {o ? <TrailStop data={o} reload={options.reload} /> : <Skeleton className="h-24" />}
          </Fold>
          <Fold id="set-o-hours" icon={Clock} title="When new trades may start" summary={o ? hours(o.settings) : 'Loading…'}>
            {o ? <EntryHours data={o} reload={options.reload} /> : <Skeleton className="h-24" />}
          </Fold>
          <Fold id="set-o-speed" icon={Hourglass} title="How fast to buy and sell" summary={o ? `Buy on ${o.settings.entryClock ?? '5m'} · sell the chart stop on ${o.settings.exitClock ?? '1m'}` : 'Loading…'}>
            {o ? <SpeedSettings data={o} reload={options.reload} /> : <Skeleton className="h-24" />}
          </Fold>
          <Fold id="set-o-safety" icon={ShieldCheck} title="Safety rules" summary={o ? [o.settings.withDay && 'with the day', o.settings.withPrev !== false && "with yesterday's close", o.settings.probation !== false && 'new combos 1 lot', o.settings.comboStreak > 0 && `rest after ${o.settings.comboStreak} losses`].filter(Boolean).join(' · ') || 'All off' : 'Loading…'}>
            {o ? <SafetyRules data={o} reload={options.reload} /> : <Skeleton className="h-24" />}
          </Fold>
          <Fold id="set-o-limits" icon={Wallet} title="Money and trade limits" summary={o ? `₹${Number(o.settings.budget).toLocaleString('en-IN')} · up to ${o.settings.maxLots} lots · ${o.settings.maxOpen} open · loss cut ${o.settings.lossCut > 0 ? `₹${o.settings.lossCut}` : 'off'}` : 'Loading…'}>
            {o ? <OptionsLimits data={o} reload={options.reload} /> : <Skeleton className="h-24" />}
          </Fold>
        </div>
      )}

      {seg === 'shares' && (
        <div className="space-y-2">
          <Fold id="set-s-stop" icon={Shield} title="Stop, profit lock, close time" summary={r ? line(r.shares, 'stop') : 'Loading…'}>
            {r ? <RulesForm key={`s${JSON.stringify(r.shares)}`} title="Shares" rules={r.shares} onSave={save('shares')} onLock={lock('shares')} saved={saved === 'shares'} /> : <Skeleton className="h-40" />}
          </Fold>
          <Fold id="set-s-hours" icon={Clock} title="When new trades may start" summary={a ? hours(a.settings) : 'Loading…'}>
            {a ? <EntryHours data={a} reload={auto.reload} path="/auto" note="The auto share trader buys only inside these hours (and before the close time above). The scanner's own setups still start at 09:20 (news gap) and 09:30 (opening range); your share combinations can buy from 09:15." /> : <Skeleton className="h-24" />}
          </Fold>
          <Fold id="set-s-rules" icon={ListChecks} title="Entry rules" summary={a ? `${a.settings.shareRules?.minuteSecond ? 'Buy on the minute, sell on the second · ' : ''}${a.settings.shareRules?.marketAgree ? 'Nifty must agree · ' : ''}filters on every share entry` : 'Loading…'}>
            {a ? <ShareEntryRules data={a} reload={auto.reload} /> : <Skeleton className="h-24" />}
          </Fold>
          <Fold id="set-s-limits" icon={Wallet} title="Money and trade limits" summary={a ? `Up to ₹${Number(a.settings.maxTradeAmount).toLocaleString('en-IN')} a trade · ${a.settings.maxOpen} open · score ${a.settings.minScore}+` : 'Loading…'}>
            <AutoLimits />
          </Fold>
        </div>
      )}
      <Fold id="set-transfer" icon={ArrowLeftRight} title="Copy settings to another app" summary="Export all settings and combinations as a file or code, or import them from another login">
        <SettingsTransfer />
      </Fold>
      <p className="px-1 text-[11px] text-muted">Each change is used by the bots, the studies and the replay alike.</p>
    </div>
  );
}
