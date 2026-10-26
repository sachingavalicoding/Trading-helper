import { useState } from 'react';
import { LogOut, RotateCcw, Sun, Moon } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { formatINR, formatPnl, pnlClass } from '../lib/format.js';
import { Badge, Card, Skeleton, Disclaimer } from '../components/ui.jsx';

function Row({ label, value, className = '' }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className={`num text-sm font-semibold ${className}`}>{value}</span>
    </div>
  );
}

/** The profit lock every new trade starts with (you can still change it per trade). */
function ProfitLockDefaults() {
  const { data, reload } = useApi('/trade-defaults', []);
  const [trigger, setTrigger] = useState(null);
  const [amount, setAmount] = useState(null);
  if (!data) return <Skeleton className="h-28" />;
  const t = trigger ?? String(data.lockTrigger);
  const a = amount ?? String(data.lockAmount);
  const bad = !(Number(a) > 0 && Number(t) > Number(a));

  async function save(patch) {
    try {
      await api('/trade-defaults', { method: 'PUT', body: patch });
      toast.success('Saved. New trades use this.');
      setTrigger(null);
      setAmount(null);
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    }
  }

  const input = 'num mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-base outline-none focus:border-accent';
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            Profit lock <Badge tone={data.lockEnabled ? 'up' : 'muted'}>{data.lockEnabled ? 'On' : 'Off'}</Badge>
          </div>
          <p className="text-xs text-muted">Protects profit on every new trade, manual or auto.</p>
        </div>
        <button type="button" role="switch" aria-checked={data.lockEnabled} aria-label="Profit lock" onClick={() => save({ lockEnabled: !data.lockEnabled })} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${data.lockEnabled ? 'bg-up' : 'bg-surface-2'}`}>
          <span className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition-transform ${data.lockEnabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-muted">
          When profit reaches (₹)
          <input className={input} inputMode="numeric" value={t} onChange={(e) => setTrigger(e.target.value)} />
        </label>
        <label className="text-xs text-muted">
          Lock in profit of (₹)
          <input className={input} inputMode="numeric" value={a} onChange={(e) => setAmount(e.target.value)} />
        </label>
      </div>
      {bad && <p className="text-xs text-down">The trigger must be larger than the amount you lock in.</p>}
      <button type="button" disabled={bad || (trigger == null && amount == null)} onClick={() => save({ lockTrigger: Number(t), lockAmount: Number(a) })} className="w-full rounded-xl bg-accent py-2.5 text-sm font-bold text-white disabled:opacity-40">
        Save
      </button>
      <p className="text-[11px] leading-snug text-muted">Example: at ₹1,000 profit the stop moves up to lock in ₹400, then follows the price ₹600 behind your best profit. It never moves back, and it can also close a trade early if price dips after a spike.</p>
    </Card>
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

      <ProfitLockDefaults />

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
