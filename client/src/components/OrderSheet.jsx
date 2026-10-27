import { useEffect, useMemo, useState } from 'react';
import { X, Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { useTick } from '../lib/tickStore.js';
import { estimateCharges, MIS_LEVERAGE } from '../lib/charges.js';
import { formatINR, formatPrice, formatPct, pnlClass } from '../lib/format.js';
import { useMarket } from '../context/MarketContext.jsx';
import { useOrderBlock } from '../lib/orderGate.js';
import { Segmented, Flash } from './ui.jsx';

const roundTick = (p) => Math.round(p / 0.05) * 0.05;
const fix2 = (p) => Number(roundTick(p).toFixed(2));

/**
 * Bottom sheet on phones, centred dialog on larger screens.
 * Defaults to a market order so a trade is: tap Buy -> tap confirm.
 * Pass `plan` ({ stopLoss, target }) and `qty` to pre-fill the stop loss, target and quantity.
 */
export function OrderSheet({ symbol, name, side: initialSide, plan, qty: initialQty, onClose }) {
  const tick = useTick(symbol);
  const { refresh } = useMarket();
  const blocked = useOrderBlock();
  const [side, setSide] = useState(initialSide);
  const [orderType, setOrderType] = useState('MARKET');
  const [qty, setQty] = useState(initialQty >= 1 ? initialQty : 1);
  const [price, setPrice] = useState('');
  // `plan` comes from the chart signal and pre-fills the stop loss and target.
  const [withBracket, setWithBracket] = useState(Boolean(plan));
  const [stopLoss, setStopLoss] = useState(plan ? String(plan.stopLoss) : '');
  const [target, setTarget] = useState(plan ? String(plan.target) : '');
  const [funds, setFunds] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const ltp = tick?.ltp;
  const isBuy = side === 'BUY';
  const ref = orderType === 'LIMIT' ? Number(price) || ltp : ltp;

  useEffect(() => {
    api('/wallet').then(setFunds).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Seed limit price and SL/target from the live price when those fields are first shown.
  useEffect(() => {
    if (orderType === 'LIMIT' && !price && ltp) setPrice(String(fix2(ltp)));
  }, [orderType, ltp, price]);

  const applyPreset = (slPct, tgtPct) => {
    if (!ref) return;
    const dir = isBuy ? 1 : -1;
    setStopLoss(String(fix2(ref * (1 - dir * slPct))));
    setTarget(String(fix2(ref * (1 + dir * tgtPct))));
  };

  useEffect(() => {
    if (withBracket && !stopLoss && !target && ref) applyPreset(0.005, 0.01);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withBracket]);

  const est = useMemo(() => {
    if (!ref || !qty) return null;
    const value = qty * ref;
    return { value, margin: value / MIS_LEVERAGE, charges: estimateCharges({ side, qty, price: ref }).total };
  }, [ref, qty, side]);

  const maxQty = funds && ref ? Math.max(0, Math.floor((funds.available * MIS_LEVERAGE) / (ref * 1.001))) : null;

  const sl = Number(stopLoss);
  const tg = Number(target);
  const risk = withBracket && sl && ref ? Math.abs(ref - sl) * qty : null;
  const reward = withBracket && tg && ref ? Math.abs(tg - ref) * qty : null;

  const bracketError = (() => {
    if (!withBracket || !ref) return null;
    if (sl && (isBuy ? sl >= ref : sl <= ref)) return `Stop-loss must be ${isBuy ? 'below' : 'above'} entry`;
    if (tg && (isBuy ? tg <= ref : tg >= ref)) return `Target must be ${isBuy ? 'above' : 'below'} entry`;
    return null;
  })();

  const canSubmit = !blocked && ltp && qty >= 1 && Number.isInteger(qty) && (orderType === 'MARKET' || Number(price) > 0) && !bracketError && !submitting;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body = { symbol, side, orderType, qty };
      if (orderType === 'LIMIT') body.price = Number(price);
      if (withBracket) {
        if (sl) body.stopLoss = sl;
        if (tg) body.target = tg;
      }
      const { order } = await api('/orders', { method: 'POST', body });
      refresh();
      if (order.status === 'REJECTED') toast.error(order.rejectReason);
      else if (order.status === 'OPEN') {
        toast(`${side} limit order placed: ${qty} ${symbol} @ ₹${formatPrice(order.price)}`);
        onClose();
      } else onClose(); // fill toast arrives over the socket
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const accent = isBuy ? 'btn-buy' : 'btn-sell';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label={`${side} ${symbol}`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/60" onClick={onClose} />
      <form onSubmit={submit} className="sheet-in pb-safe relative max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface md:max-w-md md:rounded-2xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line md:hidden" />
        <div className="flex items-start justify-between px-4 pt-3">
          <div>
            <div className="text-lg font-bold">{symbol}</div>
            <div className="text-xs text-muted">
              {name} · NSE · MIS
            </div>
          </div>
          <div className="text-right">
            <Flash value={ltp} dir={tick?.dir} className="num text-lg font-semibold">
              ₹{formatPrice(ltp)}
            </Flash>
            <div className={`num text-xs ${pnlClass(tick?.change)}`}>{formatPct(tick?.changePct)}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost -mr-2 ml-2 !p-2">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div className="grid grid-cols-2 gap-2">
            {['BUY', 'SELL'].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`btn ${side === s ? (s === 'BUY' ? 'btn-buy' : 'btn-sell') : 'btn-secondary !text-muted'}`}
              >
                {s}
              </button>
            ))}
          </div>

          <Segmented
            className="w-full"
            value={orderType}
            onChange={setOrderType}
            options={[
              { value: 'MARKET', label: 'Market' },
              { value: 'LIMIT', label: 'Limit' },
            ]}
          />

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 flex justify-between text-xs text-muted">
                Quantity {maxQty != null && <button type="button" className="font-semibold text-accent" onClick={() => setQty(Math.max(1, maxQty))}>Max {maxQty}</button>}
              </span>
              <div className="flex items-center rounded-xl border border-line bg-surface-2">
                <button type="button" aria-label="Decrease quantity" className="p-3 text-muted" onClick={() => setQty((q) => Math.max(1, q - 1))}>
                  <Minus className="h-4 w-4" />
                </button>
                <input
                  inputMode="numeric"
                  type="number"
                  min="1"
                  step="1"
                  value={qty}
                  onChange={(e) => setQty(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  className="num w-full min-w-0 bg-transparent text-center text-base font-semibold outline-none"
                  aria-label="Quantity"
                />
                <button type="button" aria-label="Increase quantity" className="p-3 text-muted" onClick={() => setQty((q) => q + 1)}>
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Price</span>
              <input
                inputMode="decimal"
                type="number"
                step="0.05"
                disabled={orderType === 'MARKET'}
                value={orderType === 'MARKET' ? '' : price}
                placeholder={orderType === 'MARKET' ? 'At market' : ''}
                onChange={(e) => setPrice(e.target.value)}
                className="field num font-semibold"
                aria-label="Limit price"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            {[1, 5, 10, 25, 50].map((n) => (
              <button key={n} type="button" onClick={() => setQty(n)} aria-pressed={qty === n} className="chip">
                {n}
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-line">
            <label className="flex cursor-pointer items-center justify-between px-3 py-3">
              <span className="text-sm font-medium">Stop-loss &amp; target</span>
              <input type="checkbox" checked={withBracket} onChange={(e) => setWithBracket(e.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />
            </label>
            {withBracket && (
              <div className="space-y-3 border-t border-line px-3 py-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs text-down">Stop-loss</span>
                    <input inputMode="decimal" type="number" step="0.05" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} className="field num !py-2.5 focus:!border-down" aria-label="Stop-loss price" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-up">Target</span>
                    <input inputMode="decimal" type="number" step="0.05" value={target} onChange={(e) => setTarget(e.target.value)} className="field num !py-2.5 focus:!border-up" aria-label="Target price" />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {[
                    [0.005, 0.01, '0.5% / 1%'],
                    [0.01, 0.02, '1% / 2%'],
                    [0.01, 0.03, '1% / 3%'],
                  ].map(([a, b, l]) => (
                    <button key={l} type="button" onClick={() => applyPreset(a, b)} className="chip">
                      {l}
                    </button>
                  ))}
                </div>
                {bracketError ? (
                  <p className="text-xs text-down">{bracketError}</p>
                ) : (
                  risk != null && (
                    <p className="num text-xs text-muted">
                      Risk <span className="text-down">{formatINR(risk)}</span> · Reward <span className="text-up">{formatINR(reward)}</span>
                      {risk > 0 && reward != null && <> · R:R 1:{(reward / risk).toFixed(2)}</>}
                    </p>
                  )
                )}
              </div>
            )}
          </div>

          <dl className="num grid grid-cols-3 gap-2 rounded-xl bg-surface-2 p-3 text-xs">
            <div>
              <dt className="text-muted">Margin (5x)</dt>
              <dd className="font-semibold">{est ? formatINR(est.margin) : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">Charges ≈</dt>
              <dd className="font-semibold">{est ? formatINR(est.charges) : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">Available</dt>
              <dd className="font-semibold">{funds ? formatINR(funds.available) : '—'}</dd>
            </div>
          </dl>

          <p className="text-center text-[11px] text-muted">Intraday (MIS). Open positions are squared off at 15:15 IST. Paper trading for learning. Not investment advice.</p>
        </div>

        {/* Confirm stays in thumb reach even when the sheet scrolls */}
        <div className="sticky bottom-0 border-t border-line bg-surface px-4 pt-3 pb-4">
          {blocked && <p className="mb-2 rounded-lg bg-warn/10 px-3 py-2 text-center text-xs font-medium text-warn">{blocked}. Orders open again when the market does.</p>}
          <button type="submit" disabled={!canSubmit} className={`btn btn-lg w-full !py-4 ${accent}`}>
            {blocked ? 'Orders are closed' : submitting ? 'Placing…' : `${side} ${qty || ''} ${symbol}${orderType === 'LIMIT' && price ? ` @ ₹${price}` : ''}`}
          </button>
        </div>
      </form>
    </div>
  );
}
