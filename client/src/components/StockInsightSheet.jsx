import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, X } from 'lucide-react';
import { useTick } from '../lib/tickStore.js';
import { insightsOf } from '../lib/insights.js';
import { formatPct, formatPrice, formatQtyCompact, pnlClass } from '../lib/format.js';
import { useOrderBlock } from '../lib/orderGate.js';
import { Badge, Flash } from './ui.jsx';
import { NewsCard } from './NewsCard.jsx';

const MOOD_TONE = { Strong: 'up', Weak: 'down', Mixed: 'muted' };

function Cell({ label, value, tone = '' }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

const signed = (v) => (v == null ? '—' : formatPct(v));

/**
 * Everything the grid row only hints at: the full day (open, high, low, VWAP, volume), the quick reads
 * (where the price sits in the day's range, gap, move from the open), the stock's news, and the way on to its chart.
 */
export function StockInsightSheet({ stock, signal, onTrade, onClose }) {
  const tick = useTick(stock.symbol);
  const blocked = useOrderBlock();
  const i = insightsOf(tick);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label={`${stock.symbol} details`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="sheet-in pb-safe relative max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface md:max-w-lg md:rounded-2xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line md:hidden" />
        <div className="flex items-start justify-between gap-3 px-4 pt-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold">{stock.symbol}</span>
              {i && <Badge tone={MOOD_TONE[i.mood]}>{i.mood}</Badge>}
            </div>
            <div className="truncate text-xs text-muted">
              {stock.name} · {stock.sector}
            </div>
          </div>
          <div className="text-right">
            <Flash value={tick?.ltp} dir={tick?.dir} className="num text-xl font-bold">
              ₹{formatPrice(tick?.ltp)}
            </Flash>
            <div className={`num text-xs font-semibold ${pnlClass(tick?.change)}`}>
              {tick?.change > 0 ? '+' : ''}
              {formatPrice(tick?.change)} ({formatPct(tick?.changePct)})
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost -mr-2 !p-2">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div>
            <div className="mb-1 flex justify-between text-[11px] text-muted">
              <span>Day low {formatPrice(tick?.low)}</span>
              <span>Day high {formatPrice(tick?.high)}</span>
            </div>
            <div className="relative h-2 rounded-full bg-surface-3">
              {i?.rangePos != null && <span className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent2" style={{ left: `${Math.round(i.rangePos * 100)}%` }} />}
            </div>
            <div className="mt-1 text-center text-[11px] text-muted">{i?.rangePos != null ? `Price is ${Math.round(i.rangePos * 100)}% of the way up today's range` : 'No range yet'}</div>
          </div>

          <dl className="grid grid-cols-3 gap-x-3 gap-y-3 rounded-xl bg-surface-2 p-3">
            <Cell label="Open" value={formatPrice(tick?.open)} />
            <Cell label="Prev close" value={formatPrice(tick?.prevClose)} />
            <Cell label="VWAP" value={formatPrice(tick?.atp)} />
            <Cell label="Gap at open" value={signed(i?.gapPct)} tone={pnlClass(i?.gapPct)} />
            <Cell label="Since open" value={signed(i?.fromOpenPct)} tone={pnlClass(i?.fromOpenPct)} />
            <Cell label="Vs VWAP" value={signed(i?.vsVwapPct)} tone={pnlClass(i?.vsVwapPct)} />
            <Cell label="Day range" value={i?.rangePct != null ? `${i.rangePct.toFixed(2)}%` : '—'} />
            <Cell label="Volume" value={formatQtyCompact(tick?.volume)} />
            <Cell label="Sector" value={stock.sector} />
          </dl>

          {signal && (
            <a href={signal.url} target="_blank" rel="noopener noreferrer" className={`block rounded-xl p-3 text-sm ${signal.label === 'BULLISH' ? 'bg-up-soft' : 'bg-down-soft'}`}>
              <div className="mb-1 flex items-center gap-2">
                <Badge tone={signal.label === 'BULLISH' ? 'up' : 'down'}>{signal.label === 'BULLISH' ? 'Good news' : 'Bad news'}</Badge>
                {signal.source && <span className="text-[11px] text-muted">{signal.source}</span>}
                <ExternalLink className="ml-auto h-3.5 w-3.5 text-muted" />
              </div>
              {signal.title}
            </a>
          )}
          <NewsCard symbol={stock.symbol} title="Latest news" limit={3} />

          <div className="grid grid-cols-2 gap-2 text-center text-sm">
            <Link to={`/stock/${encodeURIComponent(stock.symbol)}`} className="btn btn-secondary">
              Chart and depth
            </Link>
            <Link to={`/review?symbol=${encodeURIComponent(stock.symbol)}`} className="btn btn-secondary">
              Today vs the call
            </Link>
          </div>
        </div>

        <div className="sticky bottom-0 border-t border-line bg-surface px-4 pt-3 pb-4">
          {blocked && <p className="mb-2 text-center text-xs font-medium text-warn">{blocked}</p>}
          <div className="grid grid-cols-2 gap-3">
            <button type="button" disabled={Boolean(blocked) || !tick} onClick={() => onTrade('BUY')} className="btn btn-buy btn-lg">
              Buy
            </button>
            <button type="button" disabled={Boolean(blocked) || !tick} onClick={() => onTrade('SELL')} className="btn btn-sell btn-lg">
              Sell
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
