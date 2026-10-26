import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Star, X } from 'lucide-react';
import { useMarket } from '../context/MarketContext.jsx';
import { useTick } from '../lib/tickStore.js';
import { useStarred } from '../lib/useStarred.js';
import { useDeliberateTap } from '../lib/useDeliberateTap.js';
import { formatPrice, formatPct, pnlClass } from '../lib/format.js';
import { OrderSheet } from '../components/OrderSheet.jsx';
import { Card, Flash, Segmented, Skeleton, EmptyState } from '../components/ui.jsx';

const Row = memo(function Row({ stock, starred, onStar, onTrade }) {
  const t = useTick(stock.symbol);
  // Scrolling the list past these buttons must not open the order sheet.
  const buyTap = useDeliberateTap(() => onTrade(stock, 'BUY'));
  const sellTap = useDeliberateTap(() => onTrade(stock, 'SELL'));
  return (
    <li className="flex items-center gap-2 border-b border-line px-3 py-3 last:border-0">
      <button type="button" onClick={() => onStar(stock.symbol)} aria-label={starred ? `Unstar ${stock.symbol}` : `Star ${stock.symbol}`} className="p-1 text-muted">
        <Star className={`h-4 w-4 ${starred ? 'fill-warn text-warn' : ''}`} />
      </button>
      <Link to={`/stock/${encodeURIComponent(stock.symbol)}`} className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{stock.symbol}</div>
        <div className="truncate text-[11px] text-muted">{stock.name}</div>
      </Link>
      <Link to={`/stock/${encodeURIComponent(stock.symbol)}`} className="text-right">
        {t ? (
          <>
            <Flash value={t.ltp} dir={t.dir} className="num text-sm font-semibold">
              {formatPrice(t.ltp)}
            </Flash>
            <div className={`num text-[11px] ${pnlClass(t.change)}`}>
              {t.change > 0 ? '+' : ''}
              {formatPrice(t.change)} ({formatPct(t.changePct)})
            </div>
          </>
        ) : (
          <Skeleton className="h-8 w-20" />
        )}
      </Link>
      <div className="ml-1 flex gap-1">
        <button type="button" {...buyTap} className="btn btn-buy btn-sm !w-8 !px-0" aria-label={`Buy ${stock.symbol}`}>
          B
        </button>
        <button type="button" {...sellTap} className="btn btn-sell btn-sm !w-8 !px-0" aria-label={`Sell ${stock.symbol}`}>
          S
        </button>
      </div>
    </li>
  );
});

export default function Watchlist() {
  const { instruments } = useMarket();
  const { starred, toggle } = useStarred();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [sheet, setSheet] = useState(null);

  const list = useMemo(() => {
    if (!instruments) return [];
    const q = query.trim().toLowerCase();
    return instruments.stocks.filter((s) => (tab === 'starred' ? starred.has(s.symbol) : true) && (!q || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)));
  }, [instruments, query, tab, starred]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Nifty 50"
            className="field !py-2.5 !pr-9 !pl-9 !text-sm"
            aria-label="Search stocks"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-muted">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'All' },
            { value: 'starred', label: '★' },
          ]}
        />
      </div>

      <Card>
        {!instruments ? (
          <ul>
            {Array.from({ length: 10 }, (_, i) => (
              <li key={i} className="flex items-center justify-between border-b border-line px-3 py-3 last:border-0">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-8 w-20" />
              </li>
            ))}
          </ul>
        ) : list.length === 0 ? (
          <EmptyState icon={tab === 'starred' ? Star : Search} title={tab === 'starred' && !query ? 'No starred stocks yet' : 'No matches'}>
            {tab === 'starred' && !query ? 'Tap the star next to a stock to pin it here.' : 'Only Nifty 50 stocks are available.'}
          </EmptyState>
        ) : (
          <ul>
            {list.map((s) => (
              <Row key={s.symbol} stock={s} starred={starred.has(s.symbol)} onStar={toggle} onTrade={(stock, side) => setSheet({ ...stock, side })} />
            ))}
          </ul>
        )}
      </Card>

      {sheet && <OrderSheet symbol={sheet.symbol} name={sheet.name} side={sheet.side} onClose={() => setSheet(null)} />}
    </div>
  );
}
