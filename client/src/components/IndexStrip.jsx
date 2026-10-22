import { useMarket } from '../context/MarketContext.jsx';
import { useTick } from '../lib/tickStore.js';
import { formatPrice, formatPct, pnlClass } from '../lib/format.js';
import { Flash, Skeleton } from './ui.jsx';

function IndexChip({ symbol, name }) {
  const t = useTick(symbol);
  return (
    <div className="flex shrink-0 items-baseline gap-2 rounded-lg bg-surface-2 px-3 py-1.5">
      <span className="text-[11px] font-semibold uppercase text-muted">{name}</span>
      {t ? (
        <>
          <Flash value={t.ltp} dir={t.dir} className="num text-sm font-semibold">
            {formatPrice(t.ltp)}
          </Flash>
          <span className={`num text-xs ${pnlClass(t.change)}`}>{formatPct(t.changePct)}</span>
        </>
      ) : (
        <Skeleton className="h-4 w-20" />
      )}
    </div>
  );
}

export function IndexStrip() {
  const { instruments, status } = useMarket();
  if (!instruments) {
    return (
      <div className="flex gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-40" />
      </div>
    );
  }
  return (
    <div className="no-scrollbar flex gap-2 overflow-x-auto">
      {instruments.indices.map((i) => (
        <IndexChip key={i.symbol} {...i} />
      ))}
      {status?.feed?.capabilities?.giftNifty === false && (
        <div className="flex shrink-0 items-center rounded-lg bg-surface-2 px-3 py-1.5 text-[11px] text-muted" title="GIFT Nifty trades on NSE IX, which this data feed does not carry">
          GIFT NIFTY · n/a
        </div>
      )}
    </div>
  );
}
