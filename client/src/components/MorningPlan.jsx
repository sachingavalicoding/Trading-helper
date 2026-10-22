import { Link } from 'react-router-dom';
import { Sunrise } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { formatPrice } from '../lib/format.js';
import { Badge, Card, Skeleton } from './ui.jsx';

/** Pre-market watch list: which stocks matter today and the price to wait for. */
export function MorningPlan() {
  const { data, loading } = useApi('/scanner/plan', []);
  if (loading && !data) return <Skeleton className="h-28" />;
  if (!data || data.warming) return null;

  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sunrise className="h-4 w-4 text-accent" /> Today's plan
        </h2>
        {data.mood && <span className="text-[11px] text-muted">{data.mood.text}</span>}
      </div>
      {data.items.length === 0 ? (
        <p className="text-sm text-muted">Nothing stands out yet: no strong news and no stock that closed at an extreme. That is a fine day to wait.</p>
      ) : (
        <ul className="divide-y divide-line">
          {data.items.map((i) => (
            <li key={i.symbol} className="py-2 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <Link to={`/stock/${encodeURIComponent(i.symbol)}`} className="flex items-center gap-2 font-semibold">
                  {i.symbol}
                  <Badge tone={i.bias === 'BUY' ? 'up' : 'down'}>{i.bias === 'BUY' ? 'Watch buy' : 'Watch sell'}</Badge>
                </Link>
                <span className="num text-right text-sm">
                  <span className="text-[11px] text-muted">{i.bias === 'BUY' ? 'above ' : 'below '}</span>
                  {formatPrice(i.trigger.price)}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-muted">{i.why.join(' · ')}</div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] leading-snug text-muted">A watch list, not a signal. Wait for the level to break, then the scanner decides.</p>
    </Card>
  );
}
