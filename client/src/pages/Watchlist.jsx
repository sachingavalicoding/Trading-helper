import { memo, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search, Star, X } from 'lucide-react';
import { useMarket } from '../context/MarketContext.jsx';
import { getTick, useTick } from '../lib/tickStore.js';
import { useStarred } from '../lib/useStarred.js';
import { useApi } from '../lib/useApi.js';
import { insightsOf, sortRows } from '../lib/insights.js';
import { formatPrice, formatPct, formatQtyCompact, pnlClass } from '../lib/format.js';
import { OrderSheet } from '../components/OrderSheet.jsx';
import { StockInsightSheet } from '../components/StockInsightSheet.jsx';
import { TodayStrip } from '../components/TodayStrip.jsx';
import { Badge, Card, Skeleton, EmptyState } from '../components/ui.jsx';

const COLUMNS = [
  { key: 'symbol', label: 'Stock', asc: true },
  { key: 'ltp', label: 'Price' },
  { key: 'change', label: 'Chg %' },
  { key: 'range', label: 'Range' },
  { key: 'vwap', label: 'Vs VWAP' },
  { key: 'gap', label: 'Gap' },
  { key: 'volume', label: 'Volume' },
  { key: 'news', label: 'News' },
];

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'starred', label: '★' },
  { value: 'gainers', label: 'Gainers' },
  { value: 'losers', label: 'Losers' },
  { value: 'strong', label: 'Strong' },
  { value: 'news', label: 'In news' },
];

const ORDER_REFRESH_MS = 3000; // rows update live; their order only re-sorts every few seconds so they do not jump under your finger

function RangeBar({ pos }) {
  if (pos == null) return <span className="text-muted">—</span>;
  return (
    <span className="relative inline-block h-1.5 w-12 rounded-full bg-surface-3 align-middle" title={`${Math.round(pos * 100)}% of today's range`}>
      <span className="absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent2" style={{ left: `${Math.round(pos * 100)}%` }} />
    </span>
  );
}

const pctCell = (v) => (v == null ? <span className="text-muted">—</span> : <span className={pnlClass(v)}>{formatPct(v)}</span>);

const Row = memo(function Row({ stock, starred, onStar, onOpen, news }) {
  const t = useTick(stock.symbol);
  const i = insightsOf(t);
  const open = () => onOpen(stock);
  return (
    <tr
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}
      aria-label={`${stock.symbol}, tap for details`}
    >
      <td className="sticky left-0 z-10 bg-surface">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStar(stock.symbol);
            }}
            aria-label={starred ? `Unstar ${stock.symbol}` : `Star ${stock.symbol}`}
            className="-ml-1 p-1 text-muted"
          >
            <Star className={`h-3.5 w-3.5 ${starred ? 'fill-accent2 text-accent2' : ''}`} />
          </button>
          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              {stock.symbol}
              {i?.mood && i.mood !== 'Mixed' && <span className={`h-1.5 w-1.5 rounded-full ${i.mood === 'Strong' ? 'bg-up' : 'bg-down'}`} title={i.mood} />}
            </div>
            <div className="max-w-[4.75rem] truncate text-[11px] text-muted">{stock.name}</div>
          </div>
        </div>
      </td>
      <td className="num font-semibold">{formatPrice(t?.ltp)}</td>
      <td className="num font-semibold">{t ? pctCell(t.changePct) : <Skeleton className="ml-auto h-4 w-12" />}</td>
      <td>
        <RangeBar pos={i?.rangePos} />
      </td>
      <td className="num">{pctCell(i?.vsVwapPct)}</td>
      <td className="num">{pctCell(i?.gapPct)}</td>
      <td className="num text-muted">{formatQtyCompact(t?.volume)}</td>
      <td>
        {news ? (
          <Badge tone={news.label === 'BULLISH' ? 'up' : 'down'}>{news.label === 'BULLISH' ? 'Good' : 'Bad'}</Badge>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
    </tr>
  );
});

/** All of the Nifty 50 as a sortable grid of live insights. Tap a row for the full data and to trade. */
export default function Watchlist() {
  const { instruments } = useMarket();
  const { starred, toggle } = useStarred();
  const { data: newsData } = useApi('/news/summary', []);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState({ key: 'change', dir: 'desc' });
  const [picked, setPicked] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [tickOrder, setTickOrder] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTickOrder((n) => n + 1), ORDER_REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const signals = newsData?.signals || {};
  const rows = useMemo(() => {
    if (!instruments) return [];
    const q = query.trim().toLowerCase();
    const base = instruments.stocks
      .filter((s) => !q || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .map((stock) => {
        const tick = getTick(stock.symbol);
        return { stock, tick, insight: insightsOf(tick), news: signals[stock.symbol] || null };
      })
      .filter((r) => {
        if (filter === 'starred') return starred.has(r.stock.symbol);
        if (filter === 'gainers') return r.tick?.changePct > 0;
        if (filter === 'losers') return r.tick?.changePct < 0;
        if (filter === 'strong') return r.insight?.mood === 'Strong';
        if (filter === 'news') return Boolean(r.news);
        return true;
      });
    return sortRows(base, sort.key, sort.dir);
    // tickOrder re-reads the latest ticks every few seconds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instruments, query, filter, sort, starred, signals, tickOrder]);

  const sortBy = (col) => setSort((s) => (s.key === col.key ? { key: col.key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: col.key, dir: col.asc ? 'asc' : 'desc' }));

  return (
    <div className="space-y-3">
      <TodayStrip />
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Nifty 50" className="field !py-2.5 !pr-9 !pl-9 !text-sm" aria-label="Search stocks" />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-muted">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)} className="chip shrink-0">
            {f.label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {!instruments ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 10 }, (_, n) => (
              <Skeleton key={n} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={filter === 'starred' ? Star : Search} title={filter === 'starred' && !query ? 'No starred stocks yet' : 'No matches'}>
            {filter === 'starred' && !query ? 'Tap the star next to a stock to pin it here.' : 'Try another filter. Only Nifty 50 stocks are listed.'}
          </EmptyState>
        ) : (
          <div className="max-h-[calc(100dvh-22rem)] min-h-64 overflow-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={c.key === 'symbol' ? 'sticky left-0 z-20 bg-surface' : ''}>
                      <button type="button" onClick={() => sortBy(c)} className={`inline-flex items-center gap-0.5 uppercase ${sort.key === c.key ? 'text-accent2' : ''}`}>
                        {c.label}
                        {sort.key === c.key && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.stock.symbol} stock={r.stock} starred={starred.has(r.stock.symbol)} onStar={toggle} onOpen={setPicked} news={r.news} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-center text-[11px] text-muted">Tap a stock for its full data. Dot: green = strong (above VWAP, near the high), red = weak. Order refreshes every few seconds.</p>

      {picked && (
        <StockInsightSheet
          stock={picked}
          signal={signals[picked.symbol]}
          onClose={() => setPicked(null)}
          onTrade={(side) => {
            setSheet({ ...picked, side });
            setPicked(null);
          }}
        />
      )}
      {sheet && <OrderSheet symbol={sheet.symbol} name={sheet.name} side={sheet.side} onClose={() => setSheet(null)} />}
    </div>
  );
}
