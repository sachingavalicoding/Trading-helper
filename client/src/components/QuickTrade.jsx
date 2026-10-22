import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { useTick } from '../lib/tickStore.js';
import { formatPrice, formatPnl, pnlClass } from '../lib/format.js';
import { useMarket } from '../context/MarketContext.jsx';
import { readQty, saveQty } from './OrderSheet.jsx';

/**
 * One-tap market orders that live with the chart (so they also work in fullscreen):
 * SELL | quantity | BUY, plus the open position's live P&L with an Exit button.
 */
export function QuickTrade({ symbol, position }) {
  const tick = useTick(symbol);
  const { refresh } = useMarket();
  const [qty, setQtyState] = useState(readQty);
  const [busy, setBusy] = useState(false);

  const setQty = (n) => {
    const next = Math.max(1, Math.floor(Number(n) || 1));
    setQtyState(next);
    saveQty(next);
  };

  async function trade(side) {
    if (busy) return;
    setBusy(true);
    try {
      const { order } = await api('/orders', { method: 'POST', body: { symbol, side, orderType: 'MARKET', qty } });
      refresh();
      if (order.status === 'REJECTED') toast.error(order.rejectReason); // the fill toast arrives over the socket
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function exit() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/positions/${encodeURIComponent(symbol)}/exit`, { method: 'POST' });
      refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const ltp = tick?.ltp;
  const pnl = position && ltp ? (ltp - position.avgPrice) * position.netQty : null;
  const disabled = !ltp || busy;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div className="flex items-stretch overflow-hidden rounded-xl border border-line">
        <button type="button" disabled={disabled} onClick={() => trade('SELL')} className="bg-down px-4 py-2 text-sm font-bold text-white disabled:opacity-50" aria-label={`Sell ${qty} ${symbol} at market`}>
          SELL
          <span className="num block text-[10px] font-medium opacity-90">{formatPrice(ltp)}</span>
        </button>
        <div className="flex items-center bg-surface-2">
          <button type="button" aria-label="Decrease quantity" className="p-2 text-muted" onClick={() => setQty(qty - 1)}>
            <Minus className="h-4 w-4" />
          </button>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="Quick trade quantity"
            className="num w-14 bg-transparent text-center text-sm font-semibold outline-none"
          />
          <button type="button" aria-label="Increase quantity" className="p-2 text-muted" onClick={() => setQty(qty + 1)}>
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <button type="button" disabled={disabled} onClick={() => trade('BUY')} className="bg-up px-4 py-2 text-sm font-bold text-white disabled:opacity-50" aria-label={`Buy ${qty} ${symbol} at market`}>
          BUY
          <span className="num block text-[10px] font-medium opacity-90">{formatPrice(ltp)}</span>
        </button>
      </div>

      {position && (
        <div className="num ml-auto flex items-center gap-2 text-xs">
          <span className="text-muted">
            {position.netQty > 0 ? 'Long' : 'Short'} {Math.abs(position.netQty)} @ {formatPrice(position.avgPrice)}
          </span>
          <span className={`text-sm font-bold ${pnlClass(pnl)}`}>{formatPnl(pnl)}</span>
          <button type="button" disabled={busy} onClick={exit} className="rounded-lg border border-line px-3 py-1.5 font-semibold hover:bg-surface-2 disabled:opacity-50">
            Exit
          </button>
        </div>
      )}
    </div>
  );
}
