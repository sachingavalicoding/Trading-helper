import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { formatPnl, pnlClass } from '../lib/format.js';
import { Card, Segmented } from './ui.jsx';

const VIEWS = [
  { value: 'bySymbol', label: 'Stock' },
  { value: 'byDirection', label: 'Buy / Sell' },
  { value: 'byHour', label: 'Hour' },
];
const DIRECTION = { LONG: 'Bought first (long)', SHORT: 'Sold first (short)' };

/** Where closed-trade results come from, with plain-language observations. */
export function TradeBreakdown({ data }) {
  const [view, setView] = useState('bySymbol');
  if (!data?.bySymbol.length) return null;
  const rows = view === 'bySymbol' ? data.bySymbol : data[view];

  return (
    <Card className="space-y-3 p-3">
      <h3 className="text-sm font-semibold">Where your results come from</h3>
      {data.insights.length > 0 && (
        <ul className="space-y-1.5 rounded-lg bg-accent-soft p-3 text-sm">
          {data.insights.map((t) => (
            <li key={t} className="flex gap-2">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      )}
      <Segmented size="sm" options={VIEWS} value={view} onChange={setView} className="w-full" />
      <div className="divide-y divide-line text-sm">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{view === 'byHour' ? r.label : view === 'byDirection' ? DIRECTION[r.key] : r.key}</div>
              <div className="text-[11px] text-muted">
                {r.count} trade{r.count > 1 ? 's' : ''} · {r.winRate}% won · avg {formatPnl(r.avgNet)}
              </div>
            </div>
            <div className={`num font-semibold ${pnlClass(r.net)}`}>{formatPnl(r.net)}</div>
          </div>
        ))}
      </div>
      {!data.enough && <p className="rounded-lg bg-warn/15 px-3 py-2 text-xs">Habits need at least {data.minTrades} closed trades to show. Until then, treat these rows as a diary, not a pattern.</p>}
    </Card>
  );
}
