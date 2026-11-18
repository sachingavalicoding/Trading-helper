import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { useTick } from '../lib/tickStore.js';
import { useMarket } from '../context/MarketContext.jsx';
import { formatPnl, formatPrice } from '../lib/format.js';
import { Segmented } from './ui.jsx';

const TRAIL = [
  { value: 0, label: 'Off' },
  { value: 0.5, label: '0.5%' },
  { value: 1, label: '1%' },
  { value: 2, label: '2%' },
];
// A premium swings far more than a share price, so an option's trail is a much wider share of it.
const OPTION_TRAIL = [
  { value: 0, label: 'Off' },
  { value: 15, label: '15%' },
  { value: 25, label: '25%' },
  { value: 35, label: '35%' },
];
const tick05 = (p) => Number((Math.round(p / 0.05) * 0.05).toFixed(2));

/** Change the stop loss and target of an open position, or let the stop trail the price. */
export function ExitsSheet({ position, onClose }) {
  const { symbol } = position;
  const tick = useTick(symbol);
  const { refresh } = useMarket();
  const long = position.netQty > 0;
  const option = position.segment === 'OPT';
  const [stopLoss, setStopLoss] = useState('');
  const [target, setTarget] = useState('');
  const [trail, setTrail] = useState(0);
  const [lockOn, setLockOn] = useState(false);
  const [lockTrigger, setLockTrigger] = useState('1000');
  const [lockAmount, setLockAmount] = useState('400');
  const [ladder, setLadder] = useState([]);
  const [stopOff, setStopOff] = useState(false);
  const [floor, setFloor] = useState(null);
  const [askOff, setAskOff] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const ltp = tick?.ltp ?? position.ltp;

  const showExits = (e) => {
    setStopLoss(e.stopLoss != null ? String(e.stopLoss) : '');
    setTrail(e.trailPct ?? 0);
    setStopOff(Boolean(e.stopOff));
    setFloor(e.floor ?? null);
    setLadder(e.lockSteps ?? []);
  };

  useEffect(() => {
    api(`/positions/${encodeURIComponent(symbol)}/exits`)
      .then((e) => {
        showExits(e);
        setStopLoss(e.stopLoss != null ? String(e.stopLoss) : '');
        setTarget(e.target != null ? String(e.target) : '');
        setTrail(e.trailPct ?? 0);
        if (e.lockTrigger != null) {
          setLockOn(true);
          setLockTrigger(String(e.lockTrigger));
          setLockAmount(String(e.lockAmount));
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [symbol]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // the per-position stop switch takes effect at once (it does not wait for Save)
  async function switchStop(off) {
    setSwitching(true);
    try {
      const e = await api(`/positions/${encodeURIComponent(symbol)}/stop`, { method: 'PUT', body: { off } });
      showExits(e);
      setAskOff(false);
      toast[off ? 'warning' : 'success'](off ? `${symbol}: stop loss OFF. Only the emergency floor and your profit lock can sell it.` : `${symbol}: stop loss back on`);
      refresh?.();
    } catch (err) {
      toast.error(err.message || 'Could not change the stop');
    } finally {
      setSwitching(false);
    }
  }

  const invested = Math.abs(position.netQty) * position.avgPrice;
  const slNum = stopLoss === '' ? null : Number(stopLoss);
  const tgNum = target === '' ? null : Number(target);
  const error =
    ltp == null
      ? null
      : !stopOff && slNum != null && (long ? slNum >= ltp : slNum <= ltp)
        ? `Stop loss must be ${long ? 'below' : 'above'} the current price`
        : tgNum != null && (long ? tgNum <= ltp : tgNum >= ltp)
          ? `Target must be ${long ? 'above' : 'below'} the current price`
          : null;
  const lockBad = lockOn && !(Number(lockAmount) > 0 && Number(lockTrigger) > Number(lockAmount));
  const breakevenOk = ltp != null && (long ? position.avgPrice < ltp : position.avgPrice > ltp);

  async function save() {
    setSaving(true);
    try {
      await api(`/positions/${encodeURIComponent(symbol)}/exits`, { method: 'PUT', body: { ...(stopOff ? {} : { stopLoss: slNum, trailPct: trail || null }), target: tgNum, lockTrigger: lockOn ? Number(lockTrigger) : null, lockAmount: lockOn ? Number(lockAmount) : null } });
      toast.success(`${symbol} stop loss and target updated`);
      refresh?.();
      onClose();
    } catch (e) {
      toast.error(e.message || 'Could not update');
    } finally {
      setSaving(false);
    }
  }

  const input = 'field num !py-2.5';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-label={`Stop loss and target for ${symbol}`} onClick={(e) => e.stopPropagation()} className="w-full max-w-md space-y-4 rounded-t-2xl border border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:rounded-2xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-bold">{position.label || symbol}</div>
            <div className="num text-xs text-muted">
              {long ? 'Long' : 'Short'} {Math.abs(position.netQty)} @ {formatPrice(position.avgPrice)} · now {formatPrice(ltp)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost !p-1.5">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className={`rounded-xl border p-3 ${stopOff ? 'border-down bg-down-soft' : 'border-line'}`}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Stop loss {stopOff ? 'OFF' : 'on'}</div>
              <div className="text-[11px] text-muted">For this position only. Other positions keep their stops.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!stopOff}
              aria-label="Stop loss for this position"
              disabled={!loaded || switching}
              onClick={() => (stopOff ? switchStop(false) : setAskOff(true))}
              className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${stopOff ? 'bg-down' : 'bg-up'}`}
            >
              <span className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition-transform ${stopOff ? '' : 'translate-x-5'}`} />
            </button>
          </div>
          {askOff && !stopOff && (
            <div role="alertdialog" aria-label="Turn the stop loss off?" className="mt-3 space-y-2 rounded-lg border border-down bg-down-soft p-3 text-xs leading-snug">
              <p className="font-bold text-down">Risky: turn the stop loss off?</p>
              <p>
                This position will have <b>no stop loss</b>. It can fall until it has lost <b>half the money in it</b> (about <b className="num">{formatPnl(-invested / 2)}</b>), where an emergency floor sells it. The stop, trailing stop{option ? ', chart stop and break-even' : ''} stop working for it.
              </p>
              <p>Your profit lock below keeps working. Use this only on a day you are sure of the direction.</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="btn btn-sm" onClick={() => setAskOff(false)}>
                  Keep the stop
                </button>
                <button type="button" disabled={switching} className="btn btn-sm btn-outline-down" onClick={() => switchStop(true)}>
                  Turn stop off
                </button>
              </div>
            </div>
          )}
          {stopOff && (
            <p className="mt-2 text-xs leading-snug text-down">
              <b>No stop loss.</b> Emergency floor at <b className="num">{formatPrice(floor)}</b>: there it has lost half the money in it (about <span className="num">{formatPnl(-invested / 2)}</span>). Only that floor, your profit lock and the 15:15 close can sell it. Switch on to put the normal stop back.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          {!stopOff && (
            <label className="text-xs font-semibold text-down">
              Stop loss
              <input className={`${input} mt-1`} inputMode="decimal" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder="none" disabled={!loaded} />
            </label>
          )}
          <label className="text-xs font-semibold text-up">
            Target
            <input className={`${input} mt-1`} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="none" disabled={!loaded} />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          {!stopOff && (
            <>
              <button type="button" disabled={!breakevenOk} onClick={() => setStopLoss(String(tick05(position.avgPrice)))} className="chip disabled:opacity-40">
                Move stop to cost
              </button>
              <button type="button" onClick={() => setStopLoss('')} className="chip">
                Clear stop
              </button>
            </>
          )}
          <button type="button" onClick={() => setTarget('')} className="chip">
            Clear target
          </button>
        </div>

        <div className={stopOff ? 'hidden' : ''}>
          <div className="mb-1 text-xs font-semibold">Trailing stop</div>
          <Segmented size="sm" options={option ? OPTION_TRAIL : TRAIL} value={trail} onChange={setTrail} className="w-full" />
          <p className="mt-1 text-[11px] leading-snug text-muted">
            The stop follows the price at this distance and only moves towards profit, never back. It starts from the current price if you have no stop.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold">Profit lock for this position (₹)</div>
            <button type="button" role="switch" aria-checked={lockOn} aria-label="Profit lock" onClick={() => setLockOn((v) => !v)} className={`relative h-6 w-11 rounded-full transition-colors ${lockOn ? 'bg-accent' : 'bg-surface-3'}`}>
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${lockOn ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          {lockOn && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="text-[11px] text-muted">
                When profit reaches
                <input className={`${input} mt-1`} inputMode="numeric" value={lockTrigger} onChange={(e) => setLockTrigger(e.target.value)} />
              </label>
              <label className="text-[11px] text-muted">
                Lock in profit of
                <input className={`${input} mt-1`} inputMode="numeric" value={lockAmount} onChange={(e) => setLockAmount(e.target.value)} />
              </label>
            </div>
          )}
          <p className="mt-1 text-[11px] leading-snug text-muted">
            {lockOn
              ? `At ₹${Number(lockTrigger) || 0} profit the stop moves to lock in ₹${Number(lockAmount) || 0}, then keeps following the price up. The stop never moves back.${ladder.length ? ' Saving replaces your Settings ladder for this position only.' : ''}`
              : ladder.length
                ? `Your Settings ladder (${ladder.length} rows, from +₹${Math.round(ladder[0].at)} keeps ₹${Math.round(ladder[0].keep)}) is running on this position. Switch on to set your own lock for this position instead.`
                : 'Off: no automatic profit protection on this trade.'}
          </p>
          {stopOff && !lockOn && !ladder.length && <p className="mt-1 text-[11px] font-semibold text-down">No stop and no profit lock: a gain can turn into a loss down to the floor.</p>}
        </div>

        {error && <p className="text-sm text-down">{error}</p>}
        {lockBad && <p className="text-sm text-down">The profit trigger must be larger than the amount you lock in.</p>}
        <button type="button" disabled={saving || !loaded || Boolean(error) || lockBad} onClick={save} className="btn btn-primary btn-lg w-full">
          Save
        </button>
        <p className="text-center text-[11px] text-muted">Paper trading for learning. Not investment advice.</p>
      </div>
    </div>
  );
}
