import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, RefreshCw, ScanSearch } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { useTick } from '../lib/tickStore.js';
import { formatPct, pnlClass } from '../lib/format.js';
import { timeAgo } from '../components/NewsCard.jsx';
import { Badge, Card, EmptyState, Segmented, Skeleton } from '../components/ui.jsx';

const REFRESH_MS = 5 * 60_000;
const TAG = { BULLISH: { text: 'Good news', tone: 'up' }, BEARISH: { text: 'Bad news', tone: 'down' }, NEUTRAL: { text: 'Neutral', tone: 'muted' } };
const REACTION = {
  BULLISH: { AGREES: 'Price is rising with it', FADING: 'Sold: price fell after the news', FLAT: 'Price has not reacted yet' },
  BEARISH: { AGREES: 'Price is falling with it', FADING: 'Bought: price rose after the news', FLAT: 'Price has not reacted yet' },
};
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'BULLISH', label: 'Good' },
  { value: 'BEARISH', label: 'Bad' },
  { value: 'MARKET', label: 'Nifty' },
];

/** The stock a headline is about, with its live move, so the news and the price sit side by side. */
function StockChip({ item }) {
  const tick = useTick(item.symbol);
  if (item.symbol === 'MARKET') return <Badge tone="hot">Nifty and market</Badge>;
  return (
    <Link to={`/stock/${encodeURIComponent(item.symbol)}`} className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs font-semibold">
      {item.symbol}
      {tick && <span className={`num font-medium ${pnlClass(tick.changePct)}`}>{formatPct(tick.changePct)}</span>}
    </Link>
  );
}

function Headline({ item }) {
  const tag = TAG[item.label];
  const reaction = REACTION[item.label]?.[item.reaction?.state];
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StockChip item={item} />
        <Badge tone={tag.tone}>{tag.text}</Badge>
        <span className="ml-auto text-[11px] text-muted">{timeAgo(item.publishedAt)}</span>
      </div>
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm leading-snug group-hover:text-accent">{item.title}</span>
        <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-label="Opens the article" />
      </a>
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        {item.source && <span className="font-medium text-fg/80">{item.source}</span>}
        {item.reasons?.[0] && <span>· {item.reasons[0]}</span>}
        {reaction && <span className={item.reaction.state === 'FADING' ? 'font-semibold text-warn' : ''}>· {reaction}</span>}
      </div>
    </li>
  );
}

/** Every headline about the Nifty and its 50 stocks in one list. Each opens its source; each shows its stock. */
export default function News() {
  const { data, loading, error, reload } = useApi('/news/feed?hours=48&limit=200', []);
  const [filter, setFilter] = useState('all');
  const [stock, setStock] = useState('');

  useEffect(() => {
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, [reload]);

  const items = data?.items || [];
  const stocksWithNews = useMemo(() => {
    const counts = new Map();
    for (const n of items) if (n.symbol !== 'MARKET') counts.set(n.symbol, (counts.get(n.symbol) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const shown = items.filter((n) => {
    if (stock && n.symbol !== stock) return false;
    if (filter === 'MARKET') return n.symbol === 'MARKET';
    if (filter === 'all') return true;
    return n.label === filter;
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-bold">
          Nifty <span className="text-accent2">news</span>
        </h1>
        <div className="flex items-center gap-2">
          <Link to="/research" className="btn btn-secondary btn-sm">
            <ScanSearch className="h-4 w-4" /> Review
          </Link>
          <button type="button" onClick={reload} aria-label="Refresh news" className="btn btn-ghost !p-2">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <Segmented className="w-full" size="sm" value={filter} onChange={setFilter} options={FILTERS} />

      {stocksWithNews.length > 0 && (
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          <button type="button" className="chip shrink-0" aria-pressed={stock === ''} onClick={() => setStock('')}>
            All stocks
          </button>
          {stocksWithNews.map(([symbol, n]) => (
            <button key={symbol} type="button" className="chip shrink-0" aria-pressed={stock === symbol} onClick={() => setStock(stock === symbol ? '' : symbol)}>
              {symbol} <span className="ml-1 text-[10px] opacity-70">{n}</span>
            </button>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        {loading && !data ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : error && !data ? (
          <EmptyState title="News is unavailable right now">Check the connection and try again.</EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title="No headlines here yet">Headlines load a few stocks at a time, so give it a few minutes after the server starts.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((n) => (
              <Headline key={n.id} item={n} />
            ))}
          </ul>
        )}
      </Card>
      <p className="text-center text-[11px] leading-snug text-muted">{data?.disclaimer ?? 'Headlines are tagged by simple keyword rules, so a tag can be wrong. Read the headline.'}</p>
    </div>
  );
}
