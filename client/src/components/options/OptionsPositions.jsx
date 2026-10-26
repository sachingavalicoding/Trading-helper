import { useEffect, useState } from 'react';
import { CandlestickChart } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { useMarket } from '../../context/MarketContext.jsx';
import { useTick, useLtps } from '../../lib/tickStore.js';
import { formatPrice, formatPnl, formatINR, formatTime, pnlClass } from '../../lib/format.js';
import { lotsOf, premiumGain } from '../../lib/options.js';
import { ExitsSheet } from '../ExitsSheet.jsx';
import { DataTable, Stack } from '../DataTable.jsx';
import { Badge, Card, EmptyState, Flash, Skeleton } from '../ui.jsx';

function OpenRow({ p, onExit, onEdit, busy }) {
  const t = useTick(p.symbol);
  const ltp = t?.ltp ?? p.ltp;
  const pnl = ltp != null ? (ltp - p.avgPrice) * p.netQty - p.charges + p.realizedPnl : null;
  const gain = premiumGain(ltp, p.avgPrice);
  return (
    <li className="border-b border-line px-3 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{p.label}</span>
            <Badge tone={p.option?.type === 'CE' ? 'up' : 'down'}>{p.option?.type === 'CE' ? 'Call' : 'Put'}</Badge>
          </div>
          <div className="num mt-1 text-xs text-muted">
            {lotsOf(p.netQty)} lot · Qty {Math.abs(p.netQty)} · Buy {formatPrice(p.avgPrice)} · LTP{' '}
            <Flash value={ltp} dir={t?.dir}>
              {formatPrice(ltp)}
            </Flash>
          </div>
        </div>
        <div className="text-right">
          <div className={`num font-bold ${pnlClass(pnl)}`}>{formatPnl(pnl)}</div>
          <div className={`num text-[11px] ${pnlClass(gain)}`}>{gain != null ? `${gain > 0 ? '+' : ''}${(gain * 100).toFixed(1)}% premium` : '—'}</div>
        </div>
      </div>
      <div className="num mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span>Stop {p.stopLoss != null ? formatPrice(p.stopLoss) : 'none'}</span>
        <span>Final target {p.target != null ? formatPrice(p.target) : 'none'}</span>
        <span>Ladder {p.stepPrices?.length ? p.stepPrices.map(formatPrice).join(' → ') : 'none'}</span>
        <span>
          {p.trailPct ? `Trail ${p.trailPct}%` : 'No trail'}
          {p.lockTrigger ? ` · lock ₹${Math.round(p.lockAmount)} at ₹${Math.round(p.lockTrigger)}` : ''}
        </span>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={() => onEdit(p)} className="btn btn-secondary btn-sm">
          Stop / Trail
        </button>
        <button type="button" disabled={busy} onClick={() => onExit(p.symbol)} className="btn btn-secondary btn-sm">
          Exit
        </button>
      </div>
    </li>
  );
}

export const closedColumns = [
  { key: 'when', header: 'Closed', render: (p) => <Stack top={formatTime(p.closedAt)} sub={p.tradingDay} /> },
  {
    key: 'contract',
    header: 'Contract',
    render: (p) => (
      <Stack top={p.label} sub={`${lotsOf(Math.max(p.buyQty, p.sellQty))} lot · held ${Math.max(1, Math.round((new Date(p.closedAt) - new Date(p.openedAt)) / 60000))}m`} />
    ),
  },
  { key: 'px', header: 'Buy → Sell', align: 'right', render: (p) => `${formatPrice(p.buyQty ? p.buyValue / p.buyQty : null)} → ${formatPrice(p.sellQty ? p.sellValue / p.sellQty : null)}` },
  { key: 'net', header: 'Net', align: 'right', render: (p) => <Stack top={<span className={`font-bold ${pnlClass(p.netPnl)}`}>{formatPnl(p.netPnl)}</span>} sub={`charges ${formatINR(p.charges)}`} /> },
];

/** Open option positions (cards with actions) and what closed today (a table). Shares are on the Positions page. */
export function OptionsPositions() {
  const { version, status, subscribeSymbols } = useMarket();
  const today = status?.market?.istDate;
  const { data: open, loading } = useApi('/positions?status=OPEN&segment=OPT', [version]);
  const { data: closed } = useApi(today ? `/positions?status=CLOSED&segment=OPT&day=${today}` : null, [version]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const positions = open?.positions || [];
  const symbols = positions.map((p) => p.symbol);
  const ltpOf = useLtps(symbols);
  const key = symbols.join('|');
  useEffect(() => (key ? subscribeSymbols(key.split('|')) : undefined), [key, subscribeSymbols]);

  const unrealized = positions.reduce((a, p) => a + (((ltpOf(p.symbol) ?? p.ltp) != null ? ((ltpOf(p.symbol) ?? p.ltp) - p.avgPrice) * p.netQty : 0) + p.realizedPnl - p.charges), 0);

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

  const closedRows = closed?.positions || [];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Open option trades ({positions.length}){' '}
          {positions.length > 0 && (
            <span className={`num font-normal ${pnlClass(unrealized)}`}>{formatPnl(unrealized)}</span>
          )}
        </h2>
        {positions.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => window.confirm('Exit every open option trade at market and cancel their pending orders?') && run(() => api('/positions/exit-all?segment=OPT', { method: 'POST' }))}
            className="btn btn-outline-down btn-sm"
          >
            Exit all
          </button>
        )}
      </div>
      <Card>
        {loading ? (
          <div className="space-y-3 p-3">
            <Skeleton className="h-12 w-full" />
          </div>
        ) : positions.length === 0 ? (
          <EmptyState icon={CandlestickChart} title="No open option trades">
            Take one from the Signal tab, or switch the auto trader on.
          </EmptyState>
        ) : (
          <ul>
            {positions.map((p) => (
              <OpenRow key={p._id} p={p} onExit={exitOne} onEdit={setEditing} busy={busy} />
            ))}
          </ul>
        )}
      </Card>
      {closedRows.length > 0 && (
        <>
          <h2 className="pt-1 text-sm font-semibold">Closed today ({closedRows.length})</h2>
          <Card className="overflow-hidden">
            <DataTable columns={closedColumns} rows={closedRows} footer={{ when: 'Day total', net: formatPnl(closedRows.reduce((a, p) => a + p.netPnl, 0)) }} />
          </Card>
        </>
      )}
      {editing && <ExitsSheet position={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

