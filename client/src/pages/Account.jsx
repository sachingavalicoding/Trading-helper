import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, LayoutDashboard, ListOrdered, LogOut, Plus, RotateCcw, FlaskConical, SlidersHorizontal, Sun, Moon, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { DEFAULT_EXIT_MIN, MAX_ROWS, ladderLines, ladderSummary, minOfTime, nextRow, rowsFromRules, rowsProblem, stepsOf, timeText } from '../lib/ladder.js';
import { useStartingBalance } from '../lib/useStartingBalance.js';
import { formatINR, formatPnl, pnlClass } from '../lib/format.js';
import { Card, NumberBox, Segmented, Skeleton, Disclaimer, PopupTile, Sheet, useFold } from '../components/ui.jsx';
import { AutoLimits } from '../components/AutoCard.jsx';
import { OptionsLimits, StopPlacement, Switch } from '../components/options/OptionsAutoCard.jsx';
import { TrailStop } from '../components/options/TrailStop.jsx';
import { EntryChoices } from '../components/study/ReportsStudies.jsx';
import { DayReviewTile, GuideTile } from '../components/AccountExports.jsx';

function Row({ label, value, className = '' }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className={`num text-sm font-semibold ${className}`}>{value}</span>
    </div>
  );
}

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
        Close the auto trader's trades at (IST, 09:30 to 15:15)
        <input type="time" min="09:30" max="15:15" className={NUM} value={v.exitTime} onChange={(e) => edit({ exitTime: e.target.value })} />
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
        <p>{exitMin == null ? 'Enter a time from 09:30 to 15:15.' : `The auto trader closes its trades at ${v.exitTime} and takes no new one after it. The studies use this time too. A trade you place by hand is only closed by the 15:15 square-off.`}</p>
        <p>{stopNote ?? (Number(v.stopLoss) > 0 ? `Every trade starts with a stop that loses at most ₹${Number(v.stopLoss)}.` : 'No automatic stop.')}</p>
      </div>
    </div>
  );
}

const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

const clockOf = (min) => timeText(min);

/** Account > Limits: the hours new option trades may be taken (09:15 to 15:15 unless changed). */
function EntryHours({ data, reload }) {
  const s = data.settings;
  const [from, setFrom] = useState(clockOf(s.entryFrom ?? 555));
  const [to, setTo] = useState(clockOf(s.entryTo ?? 915));
  const a = minOfTime(from);
  const b = minOfTime(to);
  const bad = a == null || b == null || a < 555 || b > 915 || a + 15 > b;
  const changed = a !== (s.entryFrom ?? 555) || b !== (s.entryTo ?? 915);
  async function put() {
    try {
      await api('/options', { method: 'PUT', body: { entryFrom: a, entryTo: b } });
      toast.success('Saved. The bot, studies, Review and the Lab use these hours.');
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    }
  }
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <h4 className="text-sm font-semibold">Options: when new trades may start</h4>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          First entry (09:15 or later)
          <input type="time" min="09:15" max="15:00" className={NUM} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block text-xs text-muted">
          Last entry (up to 15:15)
          <input type="time" min="09:30" max="15:15" className={NUM} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {bad && <p className="text-xs text-down">Pick times between 09:15 and 15:15, at least 15 minutes apart.</p>}
      <button type="button" disabled={bad || !changed} onClick={put} className="btn btn-primary w-full">
        {changed ? 'Save entry hours' : 'Saved'}
      </button>
      <p className="text-[11px] leading-snug text-muted">Applies to the bot, the studies, Review and the Lab alike, so a study shows what these hours would have done. Trades you open by hand, and the time the bot closes its trades, are not affected.</p>
    </div>
  );
}

const SENSEX_STOPS = [
  { value: 'chart', label: 'Chart' },
  { value: 'cap', label: 'Capped' },
  { value: 'atr', label: 'ATR' },
  { value: 'fixed', label: 'Points' },
];

const SX = (k, base) => (k === null || k === undefined ? base : k);

/** The Sensex's own trail, break-even, hours, lots, side and patterns. A field left on "same" uses the Nifty value. */
function SensexExits({ s, choices, put }) {
  const trailMode = SX(s.sensexTrailMode, s.trailMode);
  const [draft, setDraft] = useState({});
  const val = (key, base) => (draft[key] !== undefined ? draft[key] : String(SX(s[key], base)));
  const commit = (key, base, lo, hi) => {
    const raw = draft[key];
    if (raw === undefined) return;
    setDraft((d) => ({ ...d, [key]: undefined }));
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < lo || n > hi) return toast.error(`Enter a number from ${lo} to ${hi}`);
    if (n !== SX(s[key], base)) put({ [key]: n });
  };
  const num = (key, base, label, lo, hi) => (
    <label className="block text-xs text-muted">
      {label}
      <input className={NUM} inputMode="numeric" value={val(key, base)} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} onBlur={() => commit(key, base, lo, hi)} />
      {s[key] == null && <span className="text-[10px]">Same as Nifty ({base})</span>}
    </label>
  );
  const patterns = SX(s.sensexPatterns, s.patterns) ?? [];
  const togglePattern = (k) => put({ sensexPatterns: patterns.includes(k) ? patterns.filter((x) => x !== k) : [...patterns, k] });
  const from = SX(s.sensexEntryFrom, s.entryFrom ?? 555);
  const to = SX(s.sensexEntryTo, s.entryTo ?? 915);
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <div className="text-xs font-semibold">Sensex: exits, hours and entries</div>
      <div>
        <div className="mb-1 text-xs text-muted">Trailing stop (Sensex points)</div>
        <Segmented className="w-full" size="sm" value={trailMode} onChange={(v) => put({ sensexTrailMode: v })} options={[{ value: 'off', label: 'Off' }, { value: 'points', label: 'Trail' }]} />
        {trailMode === 'points' && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {num('sensexTrailStart', s.trailStart ?? 25, 'Starts after', 0, 1000)}
            {num('sensexTrailPoints', s.trailPoints ?? 25, 'Stays behind by', 5, 1000)}
          </div>
        )}
      </div>
      {num('sensexBreakEven', s.breakEvenPoints ?? 0, 'Break-even after (Sensex points, 0 = off)', 0, 1000)}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          First entry
          <input type="time" className={NUM} value={timeText(from)} onChange={(e) => { const m = minOfTime(e.target.value); if (m != null && m >= 555 && m + 15 <= to) put({ sensexEntryFrom: m }); }} />
        </label>
        <label className="block text-xs text-muted">
          Last entry
          <input type="time" className={NUM} value={timeText(to)} onChange={(e) => { const m = minOfTime(e.target.value); if (m != null && m <= 915 && m >= from + 15) put({ sensexEntryTo: m }); }} />
        </label>
      </div>
      {num('sensexMaxLots', s.maxLots ?? 2, 'Most lots in one Sensex trade', 1, 20)}
      <div>
        <div className="mb-1 text-xs text-muted">Sensex trades</div>
        <Segmented className="w-full" size="sm" value={s.sensexSide ?? 'both'} onChange={(v) => put({ sensexSide: v })} options={[{ value: 'both', label: 'Both' }, { value: 'CE', label: 'Calls only' }, { value: 'PE', label: 'Puts only' }]} />
      </div>
      {choices.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted">Chart patterns the Sensex buys on{s.sensexPatterns == null ? ' (same as Nifty until you change one)' : ''}</div>
          <div className="flex flex-wrap gap-1.5">
            {choices.map((c) => (
              <button key={c.key} type="button" onClick={() => togglePattern(c.key)} aria-pressed={patterns.includes(c.key)} className={`rounded-full border px-2.5 py-1 text-[11px] ${patterns.includes(c.key) ? 'border-accent bg-accent/10 text-fg' : 'border-line text-muted'}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="text-[11px] leading-snug text-muted">Used by the Sensex bot, the Sensex study, Review and the Lab. Each combination also has its own Sensex-only switch, score, side and exits in Account &gt; Entries.</p>
    </div>
  );
}

/** Account > Limits: the Sensex can have its own loss limit, profit ladder and stop placement. Off, it uses the Nifty ones. */
function SensexSetup({ data, options, save, lock, saved }) {
  const sx = data.sensex;
  const s = options.data?.settings;
  const [busy, setBusy] = useState(false);
  const on = sx.own === true;
  async function toggle() {
    setBusy(true);
    try {
      await api('/trade-defaults', { method: 'PUT', body: { sensex: { own: !on } } });
      await api('/options', { method: 'PUT', body: { sensexOwn: !on } });
      toast.success(!on ? 'The Sensex now has its own stop and ladder.' : 'The Sensex uses the Nifty setup again.');
      options.reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  async function putStop(patch) {
    try {
      await api('/options', { method: 'PUT', body: patch });
      options.reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    }
  }
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">Sensex: its own setup</h4>
          <p className="text-[11px] leading-snug text-muted">The Sensex moves about three times as many points as the Nifty and its lots are priced differently, so it can have its own loss limit, profit ladder and stop. Off: it uses the Nifty ones above.</p>
        </div>
        <Switch on={on} disabled={busy} label="Sensex has its own setup" onClick={toggle} />
      </div>
      {on && (
        <div className="space-y-3">
          <RulesForm key={`x${JSON.stringify(sx)}`} title="Sensex" rules={sx} onSave={(r) => save('sensex')({ ...r, own: true })} onLock={lock('sensex')} saved={saved === 'sensex'} stopLabel="Most one Sensex trade may lose (₹)" stopNote={Number(sx.stopLoss) > 0 ? `Lots are sized so a Sensex trade at its chart stop loses at most ₹${sx.stopLoss}.` : 'No loss limit.'} />
          {s && (
            <div className="space-y-2">
              <div className="text-xs font-semibold">Sensex: where the stop goes</div>
              <Segmented className="w-full" size="sm" value={s.sensexStopMode} onChange={(v) => putStop({ sensexStopMode: v })} options={SENSEX_STOPS} />
              {(s.sensexStopMode === 'cap' || s.sensexStopMode === 'atr') && (
                <label className="flex items-center justify-between gap-3 text-xs text-muted">
                  <span>{s.sensexStopMode === 'cap' ? 'Never further than' : 'Always'} (ATRs from the entry)</span>
                  <NumberBox value={s.sensexStopAtr} min={0.8} max={2.5} decimal label="Sensex stop distance in ATRs" onSave={(n) => putStop({ sensexStopAtr: n })} />
                </label>
              )}
              {s.sensexStopMode === 'fixed' && (
                <label className="flex items-center justify-between gap-3 text-xs text-muted">
                  <span>Sensex points from the entry (20 to 600)</span>
                  <NumberBox value={s.sensexStopPoints} min={20} max={600} label="Sensex stop distance in points" onSave={(n) => putStop({ sensexStopPoints: n })} />
                </label>
              )}
              <SensexExits s={s} choices={options.data.patternChoices ?? []} put={putStop} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The limits in one short card. Tap "Set limits" for the forms, the ladder tables and the auto-trader limits. */
function TradingRules() {
  const { data, reload } = useApi('/trade-defaults', []);
  const options = useApi('/options', []);
  const [saved, setSaved] = useState('');
  const [open, setOpen] = useState(false);
  if (!data) return <Skeleton className="h-20" />;

  const save = (key) => async (rules) => {
    try {
      await api('/trade-defaults', { method: 'PUT', body: { [key]: rules } });
      toast.success('Saved. New trades use this.');
      setSaved(key);
      reload();
      options.reload();
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
      reload();
      options.reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    }
  };

  const line = (r, stopWord) => `${r.stopLoss > 0 ? `${stopWord} ${rs(r.stopLoss)}` : 'no stop'} · ${r.lockOn === false ? 'profit lock off' : ladderSummary(r.steps)} · close ${timeText(r.exitMin ?? DEFAULT_EXIT_MIN)}`;

  return (
    <>
      <PopupTile icon={SlidersHorizontal} label="Limits" hint="Stop, lock and exit time" onClick={() => setOpen(true)} />
      {open && (
        <Sheet title="Limits" subtitle={`Shares: ${line(data.shares, 'stop')}. Options: ${line(data.options, 'loss limit')}`} onClose={() => setOpen(false)}>
      <div className="space-y-5">
        <p className="text-xs text-muted">One set of rules for auto and manual trades, for new trades from the moment you save. A trade placed with its own stop keeps that stop. Type the ladder you want, change it any time.</p>
        <RulesForm key={`s${JSON.stringify(data.shares)}`} title="Shares" rules={data.shares} onSave={save('shares')} onLock={lock('shares')} saved={saved === 'shares'} />
        <RulesForm key={`o${JSON.stringify(data.options)}`} title="Options" rules={data.options} onSave={save('options')} onLock={lock('options')} saved={saved === 'options'} stopLabel="Most one trade may lose (₹)" stopNote={Number(data.options.stopLoss) > 0 ? `The bot sells when the Nifty chart level breaks, and buys only as many lots as keep that loss within ₹${data.options.stopLoss}. A hard stop sits behind it for a fast fall.` : 'No loss limit.'} />
        {options.data && <EntryHours data={options.data} reload={options.reload} />}
        <SensexSetup data={data} options={options} save={save} lock={lock} saved={saved} />
        {options.data && <StopPlacement data={options.data} reload={options.reload} />}
        {options.data && <TrailStop data={options.data} reload={options.reload} />}
        <div className="space-y-2 border-t border-line pt-3">
          <div className="text-sm font-semibold">Auto shares: limits</div>
          <AutoLimits />
        </div>
        {options.data && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="text-sm font-semibold">Auto options: limits</div>
            <OptionsLimits data={options.data} reload={options.reload} />
          </div>
        )}
      </div>
        </Sheet>
      )}
    </>
  );
}

export default function Account() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { version, refresh, status } = useMarket();
  const { data: f, loading } = useApi('/wallet', [version]);
  const [busy, setBusy] = useState(false);
  const { label: startLabel } = useStartingBalance();
  const [fundsOpen, setFundsOpen] = useFold('acct-funds', false);

  async function reset() {
    if (!window.confirm('Reset your account? All orders, positions and trade history will be deleted and your wallet goes back to ' + startLabel + '.')) return;
    setBusy(true);
    try {
      await api('/wallet/reset', { method: 'POST' });
      refresh();
      toast.success(`Wallet reset to ${startLabel}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addFunds() {
    const input = window.prompt('Add how much paper money? (₹1,000 to ₹1,00,00,000)', '10000');
    if (input == null) return;
    const amount = Number(input.replace(/[, ]/g, ''));
    if (!Number.isFinite(amount) || amount < 1000) return toast.error('Enter an amount of at least ₹1,000');
    setBusy(true);
    try {
      await api('/wallet/add-funds', { method: 'POST', body: { amount } });
      refresh();
      toast.success(`Added ${formatINR(amount)} of paper money`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 px-1 pt-1">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent text-lg font-bold text-on-accent" aria-hidden="true">
          {(user?.name || '?').trim().charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold leading-tight">{user?.name}</div>
          <div className="truncate text-xs text-muted">{user?.email}</div>
        </div>
        <button type="button" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'} className="btn btn-secondary !p-2.5">
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>

      <Card className="p-4">
        <div className="text-xs text-muted">Available to trade</div>
        <div className="num text-3xl font-bold tracking-tight">{loading && !f ? <Skeleton className="h-9 w-40" /> : formatINR(f?.available)}</div>
        <div className="mt-1 flex items-center justify-between text-xs">
          <span className="text-muted">Realised since reset</span>
          <span className={`num font-semibold ${pnlClass(f?.realizedPnl)}`}>{formatPnl(f?.realizedPnl)}</span>
        </div>
        <button type="button" onClick={() => setFundsOpen(!fundsOpen)} aria-expanded={fundsOpen} className="mt-2 flex w-full items-center justify-center gap-1 border-t border-line pt-2 text-xs font-semibold text-accent">
          {fundsOpen ? 'Hide funds details' : 'Funds details'} <ChevronDown className={`h-4 w-4 transition-transform ${fundsOpen ? 'rotate-180' : ''}`} />
        </button>
        {fundsOpen && (
          <div className="divide-y divide-line">
            <Row label="Cash balance" value={formatINR(f?.balance)} />
            <Row label="Margin used" value={formatINR(f?.usedMargin)} />
            <Row label="Blocked for pending orders" value={formatINR(f?.blockedMargin)} />
            <Row label="Starting capital" value={formatINR(f?.startingBalance)} />
          </div>
        )}
      </Card>

      <div className="grid grid-cols-3 gap-2">
        {[
          { to: '/dashboard', label: 'P&L', hint: 'Profit and loss', icon: LayoutDashboard },
          { to: '/orders', label: 'Orders', hint: 'Every order', icon: ListOrdered },
          { to: '/research', label: 'Research', hint: 'Studies, lab, finder', icon: FlaskConical },
        ].map(({ to, label, hint, icon: Icon }) => (
          <Link key={to} to={to} className="card-shadow flex flex-col items-start gap-1 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-accent2">
            <Icon className="h-5 w-5 text-accent2" />
            <span className="flex w-full items-center justify-between text-sm font-semibold">
              {label} <ChevronRight className="h-4 w-4 text-muted" />
            </span>
            <span className="text-[11px] text-muted">{hint}</span>
          </Link>
        ))}
        <DayReviewTile />
        <TradingRules />
        <EntryChoices />
        <GuideTile />
      </div>


      <Card className="divide-y divide-line">
        <button type="button" disabled={busy} onClick={addFunds} className="flex w-full items-center gap-2 px-4 py-3.5 text-sm transition-colors hover:bg-surface-2 disabled:opacity-50">
          <Wallet className="h-4 w-4" /> Add paper money
        </button>
        <button type="button" disabled={busy} onClick={reset} className="flex w-full items-center gap-2 px-4 py-3.5 text-sm text-warn transition-colors hover:bg-surface-2 disabled:opacity-50">
          <RotateCcw className="h-4 w-4" /> Reset wallet to {startLabel}
        </button>
        <button type="button" onClick={logout} className="flex w-full items-center gap-2 px-4 py-3.5 text-sm text-down transition-colors hover:bg-surface-2">
          <LogOut className="h-4 w-4" /> Log out
        </button>
      </Card>

      {status?.feed && (
        <p className="text-center text-xs text-muted">
          Data: {status.feed.provider === 'mock' ? 'simulated mock feed (not real prices)' : `${status.feed.provider} live feed`} · Leverage 5x MIS · Square-off 15:15 IST
        </p>
      )}
      <Disclaimer />
    </div>
  );
}
