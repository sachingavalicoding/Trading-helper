import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, LogOut, RotateCcw, FlaskConical, SlidersHorizontal, Sun, Moon, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { useStartingBalance } from '../lib/useStartingBalance.js';
import { formatINR, formatPnl, pnlClass } from '../lib/format.js';
import { Card, Skeleton, Disclaimer, useFold } from '../components/ui.jsx';
import { GuideTile } from '../components/AccountExports.jsx';
import { ReplayCard } from '../components/ReplayCard.jsx';
import { ReplayTestCard } from '../components/ReplayTest.jsx';

function Row({ label, value, className = '' }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className={`num text-sm font-semibold ${className}`}>{value}</span>
    </div>
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

      <nav aria-label="More" className="grid grid-cols-2 gap-2">
        {[
          { to: '/settings', label: 'Settings', hint: 'Stops, profit lock, limits, hours and safety rules of both bots', icon: SlidersHorizontal },
          { to: '/research', label: 'Research', hint: 'Test an idea, Learn, saved data and day report', icon: FlaskConical },
        ].map(({ to, label, hint, icon: Icon }) => (
          <Link key={to} to={to} className="card-shadow flex flex-col items-start gap-1 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-accent2">
            <Icon className="h-5 w-5 text-accent2" />
            <span className="flex w-full items-center justify-between text-sm font-semibold">
              {label} <ChevronRight className="h-4 w-4 text-muted" />
            </span>
            <span className="text-[11px] text-muted">{hint}</span>
          </Link>
        ))}
        <GuideTile />
      </nav>

      <ReplayCard />
      <ReplayTestCard />

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
