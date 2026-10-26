import { History } from 'lucide-react';
import { useMarket } from '../../context/MarketContext.jsx';
import { useApi } from '../../lib/useApi.js';
import { formatPnl, formatINR, pnlClass } from '../../lib/format.js';
import { DataTable } from '../DataTable.jsx';
import { Card, EmptyState, Skeleton } from '../ui.jsx';
import { closedColumns } from './OptionsPositions.jsx';

function Stat({ label, value, tone, sub }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num mt-1 text-lg font-bold ${tone || ''}`}>{value}</div>
      {sub && <div className="num mt-0.5 truncate text-[11px] text-muted">{sub}</div>}
    </Card>
  );
}

/** Every closed option trade, newest first, with the numbers that say whether options are working for you. */
export function OptionsHistory() {
  const { version } = useMarket();
  const { data, loading } = useApi('/positions?status=CLOSED&segment=OPT', [version]);
  const { data: dash } = useApi('/dashboard?segment=OPT', [version]);
  if (loading && !data) return <Skeleton className="h-48 w-full" />;
  const rows = [...(data?.positions || [])].sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  const st = dash?.stats;
  const days = [...(dash?.dailyPnl || [])].reverse();
  return (
    <div className="space-y-3">
      {st && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Net P&L" value={formatPnl(dash.totals.realizedNet)} tone={pnlClass(dash.totals.realizedNet)} sub={`charges ${formatINR(dash.totals.totalCharges)}`} />
          <Stat label="Win rate" value={st.winRate == null ? '—' : `${st.winRate}%`} sub={`${st.wins}W / ${st.losses}L of ${st.trades}`} />
          <Stat label="Avg win / loss" value={`${st.avgWin == null ? '—' : formatPnl(st.avgWin)}`} tone="text-up" sub={`avg loss ${st.avgLoss == null ? '—' : formatPnl(st.avgLoss)}`} />
          <Stat label="Profit factor" value={st.profitFactor ?? '—'} sub="gross wins ÷ gross losses" />
        </div>
      )}
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={History} title="No closed option trades yet">Each closed trade lands here with its buy and sell premium, hold time and charges.</EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <DataTable columns={closedColumns} rows={rows} footer={{ when: 'Total', net: formatPnl(rows.reduce((a, p) => a + p.netPnl, 0)) }} />
        </Card>
      )}
      {days.length > 0 && (
        <Card className="overflow-hidden">
          <DataTable
            rowKey={(d) => d.day}
            columns={[
              { key: 'day', header: 'Day', render: (d) => d.day },
              { key: 'pnl', header: 'Net P&L', align: 'right', render: (d) => <span className={`font-semibold ${pnlClass(d.pnl)}`}>{formatPnl(d.pnl)}</span> },
            ]}
            rows={days}
          />
        </Card>
      )}
    </div>
  );
}
