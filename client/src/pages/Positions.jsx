import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase } from 'lucide-react';
import { toast } from 'sonner';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { useTick, useLtps } from '../lib/tickStore.js';
import { formatPrice, formatPnl, formatINR, formatTime, pnlClass } from '../lib/format.js';
import { ExitsSheet } from '../components/ExitsSheet.jsx';
import { Card, Flash, Skeleton, Badge, EmptyState } from '../components/ui.jsx';

function OpenRow({ p, onExit, onEdit, busy }) {
  const t = useTick(p.symbol);
  const ltp = t?.ltp ?? p.ltp;
  const pnl = ltp != null ? (ltp - p.avgPrice) * p.netQty - p.charges + p.realizedPnl : null;
  const pct = ltp != null ? ((ltp - p.avgPrice) / p.avgPrice) * 100 * Math.sign(p.netQty) : null;
  return (
    <li className="border-b border-line px-3 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/stock/${encodeURIComponent(p.symbol)}`} className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{p.symbol}</span>
            <Badge tone={p.netQty > 0 ? 'up' : 'down'}>{p.netQty > 0 ? 'Long' : 'Short'}</Badge>
            <Badge>MIS</Badge>
          </div>
          <div className="num mt-1 text-xs text-muted">
            Qty {Math.abs(p.netQty)} · Avg {formatPrice(p.avgPrice)} · LTP{' '}
            <Flash value={ltp} dir={t?.dir}>
              {formatPrice(ltp)}
            </Flash>
          </div>
        </Link>
        <div className="text-right">
          <div className={`num font-bold ${pnlClass(pnl)}`}>{formatPnl(pnl)}</div>
          <div className={`num text-[11px] ${pnlClass(pct)}`}>{pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}</div>
        </div>
      </div>
      <div className="num mt-2 text-[11px] text-muted">
        SL {p.stopLoss != null ? formatPrice(p.stopLoss) : 'none'} · Target {p.target != null ? formatPrice(p.target) : 'none'}
        {p.trailPct ? ` · trailing ${p.trailPct}%` : ''}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={() => onEdit(p)} className="rounded-lg border border-line px-4 py-1.5 text-xs font-semibold hover:bg-surface-2">
          SL / Target
        </button>
        <button type="button" disabled={busy} onClick={() => onExit(p.symbol)} className="rounded-lg border border-line px-4 py-1.5 text-xs font-semibold hover:bg-surface-2 disabled:opacity-50">
          Exit
        </button>
      </div>
    </li>
  );
}

export default function Positions() {
  const { version, status } = useMarket();
  const today = status?.market?.istDate;
  const { data: open, loading } = useApi('/positions?status=OPEN', [version]);
  const { data: closed } = useApi(today ? `/positions?status=CLOSED&day=${today}` : null, [version]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const positions = open?.positions || [];
  const ltpOf = useLtps(positions.map((p) => p.symbol));

  const unrealized = positions.reduce((a, p) => {
    const ltp = ltpOf(p.symbol) ?? p.ltp;
    return a + (ltp != null ? (ltp - p.avgPrice) * p.netQty : 0);
  }, 0);
  const openCosts = positions.reduce((a, p) => a + p.realizedPnl - p.charges, 0);
  const closedNet = (closed?.positions || []).reduce((a, p) => a + p.netPnl, 0);
  const dayPnl = unrealized + openCosts + closedNet;

  async function run(fn) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }
  const exitOne = (symbol) => run(() => api(`/positions/${encodeURIComponent(symbol)}/exit`, { method: 'POST' }));
  const exitAll = () => {
    if (window.confirm('Exit all open positions at market and cancel pending orders?')) run(() => api('/positions/exit-all', { method: 'POST' }));
  };

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="text-xs text-muted">Today&apos;s P&amp;L (after charges)</div>
        <div className={`num mt-1 text-3xl font-bold ${pnlClass(dayPnl)}`}>{loading ? <Skeleton className="h-9 w-40" /> : formatPnl(dayPnl)}</div>
        <div className="num mt-2 flex gap-4 text-xs text-muted">
          <span>
            Unrealised <span className={pnlClass(unrealized)}>{formatPnl(unrealized)}</span>
          </span>
          <span>
            Booked <span className={pnlClass(closedNet)}>{formatPnl(closedNet)}</span>
          </span>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Open positions ({positions.length})</h2>
        {positions.length > 0 && (
          <button type="button" disabled={busy} onClick={exitAll} className="rounded-lg bg-down-soft px-3 py-1.5 text-xs font-semibold text-down disabled:opacity-50">
            Exit all
          </button>
        )}
      </div>
      <Card>
        {loading ? (
          <div className="space-y-3 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : positions.length === 0 ? (
          <EmptyState icon={Briefcase} title="No open positions">
            Pick a stock from the <Link to="/" className="text-accent">watchlist</Link> to place a paper trade.
          </EmptyState>
        ) : (
          <ul>
            {positions.map((p) => (
              <OpenRow key={p._id} p={p} onExit={exitOne} onEdit={setEditing} busy={busy} />
            ))}
          </ul>
        )}
      </Card>

      {closed?.positions?.length > 0 && (
        <>
          <h2 className="pt-2 text-sm font-semibold">Closed today ({closed.positions.length})</h2>
          <Card>
            <ul>
              {closed.positions.map((p) => (
                <li key={p._id} className="flex items-center justify-between border-b border-line px-3 py-3 last:border-0">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {p.symbol} <Badge tone={p.direction === 'LONG' ? 'up' : 'down'}>{p.direction === 'LONG' ? 'Long' : 'Short'}</Badge>
                    </div>
                    <div className="num text-[11px] text-muted">
                      Buy {formatPrice(p.buyQty ? p.buyValue / p.buyQty : null)} · Sell {formatPrice(p.sellQty ? p.sellValue / p.sellQty : null)} · Qty {Math.max(p.buyQty, p.sellQty)} · {formatTime(p.closedAt)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`num text-sm font-bold ${pnlClass(p.netPnl)}`}>{formatPnl(p.netPnl)}</div>
                    <div className="num text-[11px] text-muted">charges {formatINR(p.charges)}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
      {editing && <ExitsSheet position={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
