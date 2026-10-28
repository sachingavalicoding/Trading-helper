import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, LayoutDashboard, ListOrdered, LogOut, RotateCcw, ScanSearch, Sun, Moon, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { useStartingBalance } from '../lib/useStartingBalance.js';
import { formatINR, formatPnl, pnlClass } from '../lib/format.js';
import { Card, Skeleton, Disclaimer } from '../components/ui.jsx';
import { AutoLimits } from '../components/AutoCard.jsx';
import { OptionsLimits } from '../components/options/OptionsAutoCard.jsx';

function Row({ label, value, className = '' }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className={`num text-sm font-semibold ${className}`}>{value}</span>
    </div>
  );
}

const NUM = 'field num mt-1 !py-2';

/** One segment's stop and profit lock: three numbers, kept as text while typing. */
function RulesForm({ title, rules, onSave, saved, stopLabel = 'Stop loss (₹ a trade)', stopNote }) {
  const [draft, setDraft] = useState(null);
  const v = draft ?? { stopLoss: String(rules.stopLoss), lockStart: String(rules.lockStart), lockGap: String(rules.lockGap) };
  const n = (k) => Number(v[k]);
  const bad = !(n('stopLoss') >= 0) || !(n('lockStart') >= 0) || !(n('lockGap') >= 1) || (n('lockStart') > 0 && n('lockStart') <= n('lockGap'));
  const set = (k) => (e) => setDraft({ ...v, [k]: e.target.value });
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold">{title}</div>
      <div className="grid grid-cols-3 gap-3">
        <label className="text-xs text-muted">
          {stopLabel}
          <input className={NUM} inputMode="numeric" value={v.stopLoss} onChange={set('stopLoss')} />
        </label>
        <label className="text-xs text-muted">
          Lock starts at profit (₹)
          <input className={NUM} inputMode="numeric" value={v.lockStart} onChange={set('lockStart')} />
        </label>
        <label className="text-xs text-muted">
          Stays behind by (₹)
          <input className={NUM} inputMode="numeric" value={v.lockGap} onChange={set('lockGap')} />
        </label>
      </div>
      {bad && <p className="text-xs text-down">The lock start must be larger than the gap it stays behind (or 0 for no lock).</p>}
      <button type="button" disabled={bad || draft == null} onClick={async () => { if (await onSave({ stopLoss: n('stopLoss'), lockStart: n('lockStart'), lockGap: n('lockGap') })) setDraft(null); }} className="btn btn-primary w-full">
        {saved ? 'Saved' : `Save ${title.toLowerCase()}`}
      </button>
      <p className="text-[11px] leading-snug text-muted">
        {n('lockStart') > 0 && n('lockGap') > 0 && n('lockStart') > n('lockGap')
          ? `Example: at +₹${n('lockStart')} the stop keeps ₹${n('lockStart') - n('lockGap')}; at +₹${n('lockStart') + n('lockGap')} it keeps ₹${n('lockStart')}, and so on. It never moves back.`
          : 'No profit lock.'}{' '}
        {stopNote ?? (n('stopLoss') > 0 ? `Every trade starts with a stop that loses at most ₹${n('stopLoss')}.` : 'No automatic stop.')}
      </p>
    </div>
  );
}

const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

/** Profit on the left, the stop the lock keeps on the right: the whole ladder in a few rows. */
function LadderTable({ title, rules }) {
  const { lockStart: start, lockGap: gap } = rules;
  if (!(start > gap && gap > 0)) return <p className="text-xs text-muted">{title}: no profit lock.</p>;
  const rows = [0, 1, 2, 3, 4].map((i) => start + i * gap);
  return (
    <div className="text-xs">
      <div className="mb-1 font-semibold">{title}</div>
      <table className="w-full num">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-1 font-normal">Profit reaches</th>
            <th className="py-1 text-right font-normal">Stop keeps</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((profit) => (
            <tr key={profit} className="border-t border-line">
              <td className="py-1">+{rs(profit)}</td>
              <td className="py-1 text-right font-semibold">{rs(profit - gap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-muted">In between it moves {rs(1)} for every {rs(1)} of profit, always {rs(gap)} behind the best profit. It never moves back.</p>
    </div>
  );
}

/** The limits in one short card. Tap "Set limits" for the forms, the ladder tables and the auto-trader limits. */
function TradingRules() {
  const { data, reload } = useApi('/trade-defaults', []);
  const options = useApi('/options', []);
  const [saved, setSaved] = useState('');
  const [open, setOpen] = useState(false);
  if (!data) return <Skeleton className="h-28" />;

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

  const line = (r, stopWord) => `${r.stopLoss > 0 ? `${stopWord} ${rs(r.stopLoss)}` : 'no stop'} · ${r.lockStart > 0 ? `lock from +${rs(r.lockStart)}, ${rs(r.lockGap)} behind` : 'no lock'}`;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Limits</div>
          <dl className="mt-1 space-y-0.5 text-xs">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-muted">Shares</dt>
              <dd className="num">{line(data.shares, 'stop')}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-muted">Options</dt>
              <dd className="num">{line(data.options, 'loss limit')}</dd>
            </div>
          </dl>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="btn btn-secondary btn-sm shrink-0">
          {open ? 'Hide' : 'Set limits'}
        </button>
      </div>
      {open && (
        <div className="space-y-5 border-t border-line pt-3">
          <p className="text-xs text-muted">One set of rules for auto and manual trades. A trade placed with its own stop keeps that stop.</p>
          <RulesForm key={`s${JSON.stringify(data.shares)}`} title="Shares" rules={data.shares} onSave={save('shares')} saved={saved === 'shares'} />
          <RulesForm key={`o${JSON.stringify(data.options)}`} title="Options" rules={data.options} onSave={save('options')} saved={saved === 'options'} stopLabel="Most one trade may lose (₹)" stopNote={Number(data.options.stopLoss) > 0 ? `The bot sells when the Nifty chart level breaks, and buys only as many lots as keep that loss within ₹${data.options.stopLoss}. A hard stop sits behind it for a fast fall.` : 'No loss limit.'} />
          <div className="space-y-3 border-t border-line pt-3">
            <div className="text-sm font-semibold">Profit lock ladder</div>
            <LadderTable title="Shares" rules={data.shares} />
            <LadderTable title="Options" rules={data.options} />
          </div>
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
      )}
    </Card>
  );
}

export default function Account() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { version, refresh, status } = useMarket();
  const { data: f, loading } = useApi('/wallet', [version]);
  const [busy, setBusy] = useState(false);
  const { label: startLabel } = useStartingBalance();

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
      <Card className="p-4">
        <div className="text-lg font-bold">{user?.name}</div>
        <div className="text-sm text-muted">{user?.email}</div>
      </Card>

      <Card className="divide-y divide-line px-4">
        <div className="py-3">
          <div className="text-xs text-muted">Available to trade</div>
          <div className="num text-2xl font-bold">{loading && !f ? <Skeleton className="h-8 w-36" /> : formatINR(f?.available)}</div>
        </div>
        <div>
          <Row label="Cash balance" value={formatINR(f?.balance)} />
          <Row label="Margin used" value={formatINR(f?.usedMargin)} />
          <Row label="Blocked for pending orders" value={formatINR(f?.blockedMargin)} />
          <Row label="Starting capital" value={formatINR(f?.startingBalance)} />
          <Row label="Realised P&L since reset" value={formatPnl(f?.realizedPnl)} className={pnlClass(f?.realizedPnl)} />
        </div>
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
      </div>

      <TradingRules />

      <Card className="divide-y divide-line">
        <button type="button" onClick={toggle} className="flex w-full items-center justify-between px-4 py-3.5 text-sm transition-colors hover:bg-surface-2">
          <span>Theme</span>
          <span className="flex items-center gap-2 text-muted">
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} {theme === 'dark' ? 'Dark' : 'Light'}
          </span>
        </button>
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
