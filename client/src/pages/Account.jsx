import { useState } from 'react';
import { LogOut, RotateCcw, Sun, Moon } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { formatINR, formatPnl, pnlClass } from '../lib/format.js';
import { Card, Skeleton, Disclaimer } from '../components/ui.jsx';

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

  async function reset() {
    if (!window.confirm('Reset your account? All orders, positions and trade history will be deleted and your wallet goes back to ₹1,00,000.')) return;
    setBusy(true);
    try {
      await api('/wallet/reset', { method: 'POST' });
      refresh();
      toast.success('Wallet reset to ₹1,00,000');
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

      <Card className="divide-y divide-line">
        <button type="button" onClick={toggle} className="flex w-full items-center justify-between px-4 py-3.5 text-sm">
          <span>Theme</span>
          <span className="flex items-center gap-2 text-muted">
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} {theme === 'dark' ? 'Dark' : 'Light'}
          </span>
        </button>
        <button type="button" disabled={busy} onClick={reset} className="flex w-full items-center gap-2 px-4 py-3.5 text-sm text-warn disabled:opacity-50">
          <RotateCcw className="h-4 w-4" /> Reset wallet to ₹1,00,000
        </button>
        <button type="button" onClick={logout} className="flex w-full items-center gap-2 px-4 py-3.5 text-sm text-down">
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
