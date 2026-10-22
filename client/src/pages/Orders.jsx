import { useState } from 'react';
import { ListOrdered, ReceiptIndianRupee } from 'lucide-react';
import { toast } from 'sonner';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { formatPrice, formatINR, formatPnl, formatDateTime, pnlClass } from '../lib/format.js';
import { Card, Segmented, Skeleton, Badge, EmptyState } from '../components/ui.jsx';

const STATUS_TONE = { OPEN: 'accent', FILLED: 'up', CANCELLED: 'muted', REJECTED: 'down' };
const ROLE_LABEL = { ENTRY: '', EXIT: 'Exit', STOPLOSS: 'Stop-loss', TARGET: 'Target', SQUAREOFF: 'Auto square-off' };
const TYPE_LABEL = { MARKET: 'Market', LIMIT: 'Limit', SL_M: 'SL-M' };

function OrderRow({ o }) {
  const [busy, setBusy] = useState(false);
  const priceLabel = o.status === 'FILLED' ? `@ ${formatPrice(o.avgFillPrice)}` : o.orderType === 'SL_M' ? `trigger ${formatPrice(o.triggerPrice)}` : o.price ? `@ ${formatPrice(o.price)}` : 'at market';

  async function cancel() {
    setBusy(true);
    try {
      await api(`/orders/${o._id}`, { method: 'DELETE' });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-line px-3 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`text-xs font-bold ${o.side === 'BUY' ? 'text-up' : 'text-down'}`}>{o.side}</span>
            <span className="font-semibold">{o.symbol}</span>
            {ROLE_LABEL[o.role] && <Badge>{ROLE_LABEL[o.role]}</Badge>}
          </div>
          <div className="num mt-0.5 text-xs text-muted">
            {o.qty} qty · {TYPE_LABEL[o.orderType]} {priceLabel}
            {o.stopLoss ? ` · SL ${formatPrice(o.stopLoss)}` : ''}
            {o.target ? ` · Tgt ${formatPrice(o.target)}` : ''}
          </div>
          {o.rejectReason && <div className={`mt-0.5 text-[11px] ${o.status === 'REJECTED' ? 'text-down' : 'text-muted'}`}>{o.rejectReason}</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={STATUS_TONE[o.status]}>{o.status === 'OPEN' ? 'Pending' : o.status.toLowerCase()}</Badge>
          <span className="text-[11px] text-muted">{formatDateTime(o.filledAt || o.cancelledAt || o.createdAt)}</span>
        </div>
      </div>
      {o.status === 'OPEN' && (
        <div className="mt-2 flex justify-end">
          <button type="button" disabled={busy} onClick={cancel} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold hover:bg-surface-2 disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function TradeRow({ t }) {
  const [open, setOpen] = useState(false);
  const c = t.charges;
  return (
    <li className="border-b border-line last:border-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start justify-between gap-3 px-3 py-3 text-left" aria-expanded={open}>
        <div>
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-bold ${t.side === 'BUY' ? 'text-up' : 'text-down'}`}>{t.side}</span>
            <span className="font-semibold">{t.symbol}</span>
            {ROLE_LABEL[t.role] && <Badge>{ROLE_LABEL[t.role]}</Badge>}
          </div>
          <div className="num mt-0.5 text-xs text-muted">
            {t.qty} @ {formatPrice(t.price)} · {formatINR(t.value)}
          </div>
        </div>
        <div className="text-right">
          {t.realizedPnl !== 0 && <div className={`num text-sm font-semibold ${pnlClass(t.realizedPnl)}`}>{formatPnl(t.realizedPnl)}</div>}
          <div className="num text-[11px] text-muted">charges {formatINR(c.total)}</div>
          <div className="text-[11px] text-muted">{formatDateTime(t.executedAt)}</div>
        </div>
      </button>
      {open && (
        <dl className="num grid grid-cols-3 gap-2 px-3 pb-3 text-[11px] text-muted">
          <div>Brokerage <span className="text-fg">{formatINR(c.brokerage)}</span></div>
          <div>STT <span className="text-fg">{formatINR(c.stt)}</span></div>
          <div>Exchange <span className="text-fg">{formatINR(c.exchange)}</span></div>
          <div>SEBI <span className="text-fg">{formatINR(c.sebi)}</span></div>
          <div>Stamp <span className="text-fg">{formatINR(c.stamp)}</span></div>
          <div>GST <span className="text-fg">{formatINR(c.gst)}</span></div>
        </dl>
      )}
    </li>
  );
}

export default function Orders() {
  const { version } = useMarket();
  const [tab, setTab] = useState('orders');
  const orders = useApi(tab === 'orders' ? '/orders?limit=200' : null, [version]);
  const trades = useApi(tab === 'trades' ? '/trades?limit=200' : null, [version]);
  const current = tab === 'orders' ? orders : trades;
  const pending = orders.data?.orders.filter((o) => o.status === 'OPEN') || [];
  const done = orders.data?.orders.filter((o) => o.status !== 'OPEN') || [];

  return (
    <div className="space-y-3">
      <Segmented
        className="w-full"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'orders', label: 'Orders' },
          { value: 'trades', label: 'Trade book' },
        ]}
      />
      {current.loading && !current.data ? (
        <Card className="space-y-3 p-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </Card>
      ) : tab === 'orders' ? (
        orders.data?.orders.length ? (
          <>
            {pending.length > 0 && (
              <>
                <h2 className="text-sm font-semibold">Pending ({pending.length})</h2>
                <Card>
                  <ul>{pending.map((o) => <OrderRow key={o._id} o={o} />)}</ul>
                </Card>
              </>
            )}
            {done.length > 0 && (
              <>
                <h2 className="pt-1 text-sm font-semibold">History</h2>
                <Card>
                  <ul>{done.map((o) => <OrderRow key={o._id} o={o} />)}</ul>
                </Card>
              </>
            )}
          </>
        ) : (
          <Card>
            <EmptyState icon={ListOrdered} title="No orders yet" />
          </Card>
        )
      ) : trades.data?.trades.length ? (
        <Card>
          <ul>{trades.data.trades.map((t) => <TradeRow key={t._id} t={t} />)}</ul>
        </Card>
      ) : (
        <Card>
          <EmptyState icon={ReceiptIndianRupee} title="No executions yet">Filled orders show up here with a full charges breakdown.</EmptyState>
        </Card>
      )}
    </div>
  );
}
