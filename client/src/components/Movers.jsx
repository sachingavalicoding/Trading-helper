import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { useMarket } from '../context/MarketContext.jsx';
import { getTick } from '../lib/tickStore.js';
import { rankMovers } from '../lib/movers.js';
import { formatPct, pnlClass } from '../lib/format.js';
import { Card } from './ui.jsx';

function List({ title, icon: Icon, tone, rows }) {
  return (
    <div className="min-w-0 flex-1">
      <h3 className={`mb-1 flex items-center gap-1 text-xs font-semibold ${tone}`}>
        <Icon className="h-3.5 w-3.5" /> {title}
      </h3>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.symbol}>
            <Link to={`/stock/${encodeURIComponent(r.symbol)}`} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate font-medium">{r.symbol}</span>
              <span className={`num text-xs ${pnlClass(r.changePct)}`}>{formatPct(r.changePct)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Nifty 50 stocks lagging and leading the index right now: a quick place to look for sells and buys. */
export function Movers() {
  const { instruments } = useMarket();
  const [rank, setRank] = useState(null);

  useEffect(() => {
    if (!instruments) return undefined;
    const update = () => {
      const ticks = instruments.stocks.map((s) => getTick(s.symbol)).filter(Boolean);
      setRank(ticks.length >= 10 ? rankMovers(ticks, getTick('NIFTY 50')?.changePct ?? 0) : null);
    };
    update();
    const id = setInterval(update, 3000);
    return () => clearInterval(id);
  }, [instruments]);

  if (!rank) return null;
  return (
    <Card className="space-y-2 p-3">
      <div className="text-sm font-semibold">Weakest and strongest vs Nifty 50</div>
      <div className="flex gap-4">
        <List title="Weakest (sell watch)" icon={TrendingDown} tone="text-down" rows={rank.weakest} />
        <List title="Strongest (buy watch)" icon={TrendingUp} tone="text-up" rows={rank.strongest} />
      </div>
      <p className="text-[11px] leading-snug text-muted">A watch list, not a signal. Wait for the scanner or the chart signal to confirm. Not investment advice.</p>
    </Card>
  );
}
