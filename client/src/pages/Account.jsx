import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, LayoutDashboard, ListOrdered, LogOut, Plus, RotateCcw, ScanSearch, SlidersHorizontal, Sun, Moon, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { DEFAULT_EXIT_MIN, MAX_ROWS, ladderLines, ladderSummary, minOfTime, nextRow, rowsFromRules, rowsProblem, stepsOf, timeText } from '../lib/ladder.js';
import { useStartingBalance } from '../lib/useStartingBalance.js';
import { formatINR, formatPnl, pnlClass } from '../lib/format.js';
import { Card, Skeleton, Disclaimer, PopupTile, Sheet, useFold } from '../components/ui.jsx';
import { AutoLimits } from '../components/AutoCard.jsx';
import { OptionsLimits, StopPlacement, Switch } from '../components/options/OptionsAutoCard.jsx';
import { TrailStop } from '../components/options/TrailStop.jsx';
import { EntryChoices, ReportsAndStudies } from '../components/study/ReportsStudies.jsx';

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
          { to: '/review', label: 'Review', hint: 'Calls vs results', icon: ScanSearch },
        ].map(({ to, label, hint, icon: Icon }) => (
          <Link key={to} to={to} className="card-shadow flex flex-col items-start gap-1 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-accent2">
            <Icon className="h-5 w-5 text-accent2" />
            <span className="flex w-full items-center justify-between text-sm font-semibold">
              {label} <ChevronRight className="h-4 w-4 text-muted" />
            </span>
            <span className="text-[11px] text-muted">{hint}</span>
          </Link>
        ))}
        <TradingRules />
        <EntryChoices />
        <ReportsAndStudies />
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
