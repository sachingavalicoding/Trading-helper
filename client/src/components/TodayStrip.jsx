import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { formatPnl, pnlClass } from '../lib/format.js';
import { Skeleton } from './ui.jsx';

function Tile({ to, label, enabled, today }) {
  return (
    <Link to={to} className="card-shadow min-w-0 flex-1 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-accent2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted">
          <Bot className="h-3.5 w-3.5" /> {label}
        </span>
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${enabled ? 'bg-up-soft text-up' : 'bg-surface-2 text-muted'}`}>{enabled == null ? '…' : enabled ? 'On' : 'Off'}</span>
      </div>
      {today ? (
        <>
          <div className={`num mt-1 text-lg font-bold leading-tight ${pnlClass(today.pnl)}`}>{formatPnl(today.pnl)}</div>
          <div className="text-[11px] text-muted">
            {today.trades} trade{today.trades === 1 ? '' : 's'} today · {today.open} open
          </div>
        </>
      ) : (
        <Skeleton className="mt-1.5 h-9 w-24" />
      )}
    </Link>
  );
}

/** The two auto traders at a glance: on or off, and what they made today. Tap one to open it. */
export function TodayStrip() {
  const { version } = useMarket();
  const auto = useApi('/auto', [version]);
  const options = useApi('/options', [version]);
  return (
    <div className="flex gap-2">
      <Tile to="/scanner" label="Auto shares" enabled={auto.data?.settings.enabled} today={auto.data?.today} />
      <Tile to="/options" label="Auto options" enabled={options.data?.settings.enabled} today={options.data?.today} />
    </div>
  );
}
