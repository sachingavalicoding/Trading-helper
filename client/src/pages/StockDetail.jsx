import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useMarket } from '../context/MarketContext.jsx';
import { useTick } from '../lib/tickStore.js';
import { useApi } from '../lib/useApi.js';
import { useDeliberateTap } from '../lib/useDeliberateTap.js';
import { useOrderBlock } from '../lib/orderGate.js';
import { api } from '../lib/api.js';
import { formatPrice, formatPct, formatPnl, formatQtyCompact, pnlClass } from '../lib/format.js';
import { CandleChart } from '../components/CandleChart.jsx';
import { DepthPanel } from '../components/DepthPanel.jsx';
import { SignalCard } from '../components/SignalCard.jsx';
import { NewsCard } from '../components/NewsCard.jsx';
import { OrderSheet } from '../components/OrderSheet.jsx';
import { ExitsSheet } from '../components/ExitsSheet.jsx';
import { Card, Flash, Skeleton, Badge, EmptyState } from '../components/ui.jsx';

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="num text-sm font-medium">{value}</div>
    </div>
  );
}

export default function StockDetail() {
  const symbol = decodeURIComponent(useParams().symbol || '').toUpperCase();
  const { instruments, subscribeDepth, version, status } = useMarket();
  const tick = useTick(symbol);
  const [sheet, setSheet] = useState(null); // { side, plan? }
  const [exitsFor, setExitsFor] = useState(null);
  const blocked = useOrderBlock();
  // Only a deliberate tap opens the order sheet, never a chart drag that ends on the button.
  const buyTap = useDeliberateTap(() => setSheet({ side: 'BUY' }));
  const sellTap = useDeliberateTap(() => setSheet({ side: 'SELL' }));
  const stock = instruments?.stocks.find((s) => s.symbol === symbol);
  const known = !instruments || stock;

  useEffect(() => (stock ? subscribeDepth(symbol) : undefined), [symbol, stock, subscribeDepth]);

  const { data: posData } = useApi(stock ? '/positions?status=OPEN' : null, [version]);
  const { data: ordData } = useApi(stock ? '/orders?status=OPEN' : null, [version]);
  const position = posData?.positions.find((p) => p.symbol === symbol);
  const legs = ordData?.orders.filter((o) => o.symbol === symbol) || [];

  const lines = useMemo(() => {
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const out = [];
    if (position) out.push({ price: position.avgPrice, color: css('--accent'), title: `Avg ${position.netQty > 0 ? 'L' : 'S'}` });
    for (const o of legs) {
      if (o.role === 'STOPLOSS') out.push({ price: o.triggerPrice, color: css('--down'), title: 'SL' });
      else if (o.role === 'TARGET') out.push({ price: o.price, color: css('--up'), title: 'Target' });
      else if (o.orderType === 'LIMIT') out.push({ price: o.price, color: css('--muted'), title: `${o.side} LMT` });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.avgPrice, position?.netQty, JSON.stringify(legs.map((l) => [l._id, l.price, l.triggerPrice]))]);

  if (!known) {
    return <EmptyState title="Stock not found">Only Nifty 50 stocks can be traded here. <Link to="/" className="text-accent">Back to watchlist</Link></EmptyState>;
  }

  const unrealized = position && tick ? (tick.ltp - position.avgPrice) * position.netQty : null;

  async function exit() {
    try {
      await api(`/positions/${encodeURIComponent(symbol)}/exit`, { method: 'POST' });
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div className="space-y-3 pb-24 md:pb-0">
      <div className="flex items-start gap-2">
        <Link to="/" aria-label="Back" className="-ml-2 rounded-lg p-2 text-muted hover:bg-surface-2">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">{symbol}</h1>
            <Badge>NSE</Badge>
          </div>
          <div className="truncate text-xs text-muted">{stock ? `${stock.name} · ${stock.sector}` : <Skeleton className="h-3 w-40" />}</div>
        </div>
        <div className="text-right">
          {tick ? (
            <>
              <Flash value={tick.ltp} dir={tick.dir} className="num text-2xl font-bold">
                ₹{formatPrice(tick.ltp)}
              </Flash>
              <div className={`num text-sm ${pnlClass(tick.change)}`}>
                {tick.change > 0 ? '+' : ''}
                {formatPrice(tick.change)} ({formatPct(tick.changePct)})
              </div>
            </>
          ) : (
            <Skeleton className="h-12 w-28" />
          )}
        </div>
      </div>

      {/* Chart first and edge-to-edge on phones, like TradingView's app */}
      <div className="-mx-4 min-w-0 border-y border-line bg-surface px-2 py-2 sm:mx-0 sm:rounded-xl sm:border sm:p-3">
        <CandleChart symbol={symbol} lines={lines} />
      </div>

      {position && (
        <Card className="flex items-center justify-between gap-3 p-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Badge tone={position.netQty > 0 ? 'up' : 'down'}>{position.netQty > 0 ? 'Long' : 'Short'}</Badge>
              <span className="num">
                {Math.abs(position.netQty)} @ {formatPrice(position.avgPrice)}
              </span>
            </div>
            <div className={`num mt-1 text-lg font-bold ${pnlClass(unrealized)}`}>{formatPnl(unrealized)}</div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setExitsFor(position)} className="btn btn-secondary">
              SL / Target
            </button>
            <button type="button" onClick={exit} className="btn btn-secondary">
              Exit
            </button>
          </div>
        </Card>
      )}


      {stock && <SignalCard symbol={symbol} onUsePlan={(side, plan) => setSheet({ side, plan })} />}

      {stock && <NewsCard symbol={symbol} title={`${symbol} news`} />}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
        <Card className="num grid grid-cols-3 gap-3 p-3 sm:grid-cols-6">
        <Stat label="Open" value={formatPrice(tick?.open)} />
        <Stat label="High" value={formatPrice(tick?.high)} />
        <Stat label="Low" value={formatPrice(tick?.low)} />
        <Stat label="Prev close" value={formatPrice(tick?.prevClose)} />
        <Stat label="Volume" value={formatQtyCompact(tick?.volume)} />
        <Stat label="ATP" value={formatPrice(tick?.atp)} />
        </Card>

        <DepthPanel symbol={symbol} />
      </div>

      {status?.market && !status.market.isOpen && (
        <p className="text-center text-xs text-muted">
          NSE is closed ({status.market.phase.toLowerCase().replace('_', '-')}).{' '}
          {status.feed.simulated ? 'You are practising on the simulated feed.' : 'Prices shown are the last traded values.'}
        </p>
      )}

      {/* Sticky Buy/Sell bar: sits above the bottom tab bar on phones */}
      <div className="fixed inset-x-0 bottom-[calc(57px+env(safe-area-inset-bottom))] z-30 border-t border-line bg-surface/95 px-4 py-1.5 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0">
        {blocked && <p className="mb-1 text-center text-[11px] font-medium text-warn">{blocked}</p>}
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-3">
          <button type="button" {...buyTap} disabled={!tick || Boolean(blocked)} className="btn btn-buy btn-lg">
            BUY
          </button>
          <button type="button" {...sellTap} disabled={!tick || Boolean(blocked)} className="btn btn-sell btn-lg">
            SELL
          </button>
        </div>
      </div>

      {exitsFor && <ExitsSheet position={exitsFor} onClose={() => setExitsFor(null)} />}
      {sheet && <OrderSheet symbol={symbol} name={stock?.name} side={sheet.side} plan={sheet.plan} onClose={() => setSheet(null)} />}
    </div>
  );
}
