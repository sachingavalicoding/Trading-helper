import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { useTick } from '../lib/tickStore.js';
import { useMarket } from '../context/MarketContext.jsx';
import { formatPrice } from '../lib/format.js';
import { Segmented } from './ui.jsx';

const TRAIL = [
  { value: 0, label: 'Off' },
  { value: 0.5, label: '0.5%' },
  { value: 1, label: '1%' },
  { value: 2, label: '2%' },
];
const tick05 = (p) => Number((Math.round(p / 0.05) * 0.05).toFixed(2));

/** Change the stop loss and target of an open position, or let the stop trail the price. */
export function ExitsSheet({ position, onClose }) {
  const { symbol } = position;
  const tick = useTick(symbol);
  const { refresh } = useMarket();
  const long = position.netQty > 0;
  const [stopLoss, setStopLoss] = useState('');
  const [target, setTarget] = useState('');
  const [trail, setTrail] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const ltp = tick?.ltp ?? position.ltp;

  useEffect(() => {
    api(`/positions/${encodeURIComponent(symbol)}/exits`)
      .then((e) => {
        setStopLoss(e.stopLoss != null ? String(e.stopLoss) : '');
        setTarget(e.target != null ? String(e.target) : '');
        setTrail(e.trailPct ?? 0);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [symbol]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const slNum = stopLoss === '' ? null : Number(stopLoss);
  const tgNum = target === '' ? null : Number(target);
  const error =
    ltp == null
      ? null
      : slNum != null && (long ? slNum >= ltp : slNum <= ltp)
        ? `Stop loss must be ${long ? 'below' : 'above'} the current price`
        : tgNum != null && (long ? tgNum <= ltp : tgNum >= ltp)
          ? `Target must be ${long ? 'above' : 'below'} the current price`
          : null;
  const breakevenOk = ltp != null && (long ? position.avgPrice < ltp : position.avgPrice > ltp);

  async function save() {
    setSaving(true);
    try {
      await api(`/positions/${encodeURIComponent(symbol)}/exits`, { method: 'PUT', body: { stopLoss: slNum, target: tgNum, trailPct: trail || null } });
      toast.success(`${symbol} stop loss and target updated`);
      refresh?.();
      onClose();
    } catch (e) {
      toast.error(e.message || 'Could not update');
    } finally {
      setSaving(false);
    }
  }

  const input = 'num w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-base outline-none focus:border-accent';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-label={`Stop loss and target for ${symbol}`} onClick={(e) => e.stopPropagation()} className="w-full max-w-md space-y-4 rounded-t-2xl border border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:rounded-2xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-bold">{symbol}</div>
            <div className="num text-xs text-muted">
              {long ? 'Long' : 'Short'} {Math.abs(position.netQty)} @ {formatPrice(position.avgPrice)} · now {formatPrice(ltp)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold text-down">
            Stop loss
            <input className={`${input} mt-1`} inputMode="decimal" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder="none" disabled={!loaded} />
          </label>
          <label className="text-xs font-semibold text-up">
            Target
            <input className={`${input} mt-1`} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="none" disabled={!loaded} />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!breakevenOk} onClick={() => setStopLoss(String(tick05(position.avgPrice)))} className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium disabled:opacity-40">
            Move stop to cost
          </button>
          <button type="button" onClick={() => setStopLoss('')} className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium">
            Clear stop
          </button>
          <button type="button" onClick={() => setTarget('')} className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium">
            Clear target
          </button>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold">Trailing stop</div>
          <Segmented size="sm" options={TRAIL} value={trail} onChange={setTrail} className="w-full" />
          <p className="mt-1 text-[11px] leading-snug text-muted">
            The stop follows the price at this distance and only moves towards profit, never back. It starts from the current price if you have no stop.
          </p>
        </div>

        {error && <p className="text-sm text-down">{error}</p>}
        <button type="button" disabled={saving || !loaded || Boolean(error)} onClick={save} className="w-full rounded-xl bg-accent py-3 text-base font-bold text-white disabled:opacity-50">
          Save
        </button>
        <p className="text-center text-[11px] text-muted">Paper trading for learning. Not investment advice.</p>
      </div>
    </div>
  );
}
