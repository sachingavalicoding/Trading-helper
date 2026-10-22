import { useMemo } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { useLtps } from '../lib/tickStore.js';
import { IST_OFFSET_SEC } from '../lib/chart.js';
import { formatPnl, formatINR, formatDateTime, pnlClass } from '../lib/format.js';
import { MiniChart } from '../components/MiniChart.jsx';
import { Card, Skeleton, EmptyState, Disclaimer } from '../components/ui.jsx';

function Stat({ label, value, tone, sub }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num mt-1 text-lg font-bold ${tone || ''}`}>{value}</div>
      {sub && <div className="num mt-0.5 truncate text-[11px] text-muted">{sub}</div>}
    </Card>
  );
}

export default function Dashboard() {
  const { version } = useMarket();
  const { data, loading } = useApi('/dashboard', [version]);
  const open = data?.openPositions || [];
  const ltpOf = useLtps(open.map((p) => p.symbol));

  const unrealized = open.reduce((a, p) => {
    const ltp = ltpOf(p.symbol) ?? p.ltp;
    return a + (ltp != null ? (ltp - p.avgPrice) * p.netQty : 0);
  }, 0);

  const equity = useMemo(() => {
    const seen = new Map();
    for (const pt of data?.equityCurve || []) {
      if (!pt.time) continue;
      seen.set(Math.floor(new Date(pt.time).getTime() / 1000) + IST_OFFSET_SEC, pt.equity);
    }
    return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  }, [data]);
  const daily = useMemo(() => (data?.dailyPnl || []).map((d) => ({ time: d.day, value: d.pnl })), [data]);

  if (loading && !data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  const { totals, stats } = data;
  const total = totals.realizedNet + unrealized;

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="text-xs text-muted">Total P&amp;L (after charges)</div>
        <div className={`num mt-1 text-3xl font-bold ${pnlClass(total)}`}>{formatPnl(total)}</div>
        <div className="num mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>
            Realised <span className={pnlClass(totals.realizedNet)}>{formatPnl(totals.realizedNet)}</span>
          </span>
          <span>
            Unrealised <span className={pnlClass(unrealized)}>{formatPnl(unrealized)}</span>
          </span>
          <span>Charges paid {formatINR(totals.totalCharges)}</span>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Win rate" value={stats.winRate == null ? '—' : `${stats.winRate}%`} sub={`${stats.wins}W / ${stats.losses}L of ${stats.trades}`} />
        <Stat label="Profit factor" value={stats.profitFactor ?? '—'} sub="Gross wins ÷ gross losses" />
        <Stat label="Best trade" value={stats.best ? formatPnl(stats.best.net) : '—'} tone={pnlClass(stats.best?.net)} sub={stats.best ? `${stats.best.symbol} · ${formatDateTime(stats.best.closedAt)}` : null} />
        <Stat label="Worst trade" value={stats.worst ? formatPnl(stats.worst.net) : '—'} tone={pnlClass(stats.worst?.net)} sub={stats.worst ? `${stats.worst.symbol} · ${formatDateTime(stats.worst.closedAt)}` : null} />
        <Stat label="Avg win" value={stats.avgWin == null ? '—' : formatPnl(stats.avgWin)} tone="text-up" />
        <Stat label="Avg loss" value={stats.avgLoss == null ? '—' : formatPnl(stats.avgLoss)} tone="text-down" />
        <Stat label="Gross realised" value={formatPnl(totals.grossRealized)} tone={pnlClass(totals.grossRealized)} sub="Before charges" />
        <Stat label="Open positions" value={open.length} />
      </div>

      {equity.length < 2 ? (
        <Card>
          <EmptyState icon={LayoutDashboard} title="No closed trades yet">Your equity curve and daily P&amp;L appear after your first trades.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="p-3">
            <h3 className="mb-2 text-sm font-semibold">Equity curve</h3>
            <MiniChart kind="area" data={equity} />
          </Card>
          <Card className="p-3">
            <h3 className="mb-2 text-sm font-semibold">Daily P&amp;L</h3>
            <MiniChart kind="histogram" data={daily} />
          </Card>
        </div>
      )}
      <Disclaimer />
    </div>
  );
}
