import { useTick } from '../lib/tickStore.js';
import { formatPrice, formatInt, formatQtyCompact } from '../lib/format.js';
import { Card, Skeleton } from './ui.jsx';

export function DepthPanel({ symbol }) {
  const t = useTick(symbol);
  const depth = t?.depth;
  if (!depth) {
    return (
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">Market depth</h3>
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </Card>
    );
  }
  const maxQty = Math.max(...depth.bids.map((b) => b.qty), ...depth.asks.map((a) => a.qty), 1);
  const tb = t.totalBuyQty ?? depth.bids.reduce((a, b) => a + b.qty, 0);
  const ts = t.totalSellQty ?? depth.asks.reduce((a, b) => a + b.qty, 0);
  const buyPct = tb + ts > 0 ? (tb / (tb + ts)) * 100 : 50;

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Market depth</h3>
        <span className="text-[11px] text-muted">Top 5</span>
      </div>
      <div className="num grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="mb-1 flex justify-between text-muted">
            <span>Bid</span>
            <span>Qty</span>
          </div>
          {depth.bids.map((b, i) => (
            <div key={i} className="relative flex justify-between py-1">
              <div className="absolute inset-y-0 right-0 rounded-sm bg-up-soft" style={{ width: `${(b.qty / maxQty) * 100}%` }} />
              <span className="relative text-up">{formatPrice(b.price)}</span>
              <span className="relative">{formatInt(b.qty)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 flex justify-between text-muted">
            <span>Ask</span>
            <span>Qty</span>
          </div>
          {depth.asks.map((a, i) => (
            <div key={i} className="relative flex justify-between py-1">
              <div className="absolute inset-y-0 left-0 rounded-sm bg-down-soft" style={{ width: `${(a.qty / maxQty) * 100}%` }} />
              <span className="relative text-down">{formatPrice(a.price)}</span>
              <span className="relative">{formatInt(a.qty)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4">
        <div className="num mb-1 flex justify-between text-xs">
          <span className="text-up">Buy {formatQtyCompact(tb)}</span>
          <span className="text-down">Sell {formatQtyCompact(ts)}</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-down" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(buyPct)} aria-label="Buy pressure">
          <div className="h-full bg-up transition-[width] duration-500" style={{ width: `${buyPct}%` }} />
        </div>
        <div className="mt-1 text-center text-[11px] text-muted">{buyPct >= 50 ? `${buyPct.toFixed(0)}% buy pressure` : `${(100 - buyPct).toFixed(0)}% sell pressure`}</div>
      </div>
    </Card>
  );
}
