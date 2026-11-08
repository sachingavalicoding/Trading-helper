import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { STOP_MODES, fromSaved, roomSteps, toPayload } from '../../lib/combos.js';
import { Card, Segmented } from '../ui.jsx';

// Order settings of one combination: what it trades with after it fires. Shares: buy or short, risk a trade, the most money in a trade,
// the stop, the profit lock or a target, and the time its trades close. Options: calls or puts, the stop, the profit ladder, trail and break-even.
// Empty means "the Account one". The Combination Lab tries them before saving; Account > Entries edits the same fields.

const MODES3 = [
  { value: 'account', label: 'Account' },
  { value: 'off', label: 'Off' },
  { value: 'own', label: 'Own' },
];

/** Profit ladder, trail and break-even for one combination. A missing key means the Account > Limits and Entries one. */
export function ExitsBlock({ exits, onChange }) {
  const e = exits || {};
  const put = (patch) => {
    const next = { ...e, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const ladderMode = !('steps' in e) ? 'account' : e.steps?.length ? 'own' : 'off';
  const trailMode = !('trail' in e) ? 'account' : e.trail ? 'own' : 'off';
  const beMode = !('breakEven' in e) ? 'account' : e.breakEven ? 'own' : 'off';
  const start = e.steps?.[0]?.at ?? 1000;
  const gap = e.steps?.[0] ? e.steps[0].at - e.steps[0].keep : 500;
  const num = (v) => Number(String(v).replace(/[^\d.]/g, '')) || 0;
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted">Exits for this combination. Account keeps the ones from Account &gt; Limits and Entries.</div>
      <div className="space-y-1">
        <div className="text-xs font-semibold">Profit ladder</div>
        <Segmented className="w-full" size="sm" value={ladderMode} onChange={(v) => put({ steps: v === 'account' ? undefined : v === 'off' ? [] : roomSteps(start, gap) })} options={MODES3} />
        {ladderMode === 'own' && (
          <div className="grid grid-cols-2 gap-2 text-xs text-muted">
            <label className="flex items-center justify-between gap-2">
              <span>First lock at (₹)</span>
              <input className="field num !w-20 !px-2 !py-1.5 text-right !text-sm" inputMode="numeric" value={start} onChange={(ev) => put({ steps: roomSteps(Math.max(100, num(ev.target.value)), gap) })} aria-label="First profit lock" />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Room (₹)</span>
              <input className="field num !w-20 !px-2 !py-1.5 text-right !text-sm" inputMode="numeric" value={gap} onChange={(ev) => put({ steps: roomSteps(start, Math.max(50, Math.min(num(ev.target.value), start - 1))) })} aria-label="Room under the gain" />
            </label>
          </div>
        )}
      </div>
      <div className="space-y-1">
        <div className="text-xs font-semibold">Trail</div>
        <Segmented className="w-full" size="sm" value={trailMode} onChange={(v) => put({ trail: v === 'account' ? undefined : v === 'off' ? null : { points: e.trail?.points ?? 30 } })} options={MODES3} />
        {trailMode === 'own' && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>Points behind the best price (5 to 150)</span>
            <input className="field num !w-20 !px-2 !py-1.5 text-right !text-sm" inputMode="numeric" value={e.trail.points} onChange={(ev) => put({ trail: { ...e.trail, points: num(ev.target.value) } })} aria-label="Trail points" />
          </label>
        )}
      </div>
      <div className="space-y-1">
        <div className="text-xs font-semibold">Break-even</div>
        <Segmented className="w-full" size="sm" value={beMode} onChange={(v) => put({ breakEven: v === 'account' ? undefined : v === 'off' ? 0 : e.breakEven || 20 })} options={MODES3} />
        {beMode === 'own' && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>Move the stop to the entry after (5 to 150 points)</span>
            <input className="field num !w-20 !px-2 !py-1.5 text-right !text-sm" inputMode="numeric" value={e.breakEven} onChange={(ev) => put({ breakEven: num(ev.target.value) })} aria-label="Break-even points" />
          </label>
        )}
      </div>
    </div>
  );
}

const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const num = (v) => Number(String(v).replace(/[^\d.]/g, '')) || 0;
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const EXIT_TIMES = Array.from({ length: 23 }, (_, i) => 9 * 60 + 30 + i * 15); // 09:30 to 15:00 every 15 minutes, then 15:15
EXIT_TIMES.push(15 * 60 + 15);

function Money({ label, value, placeholder, onChange, aria }) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-muted">
      <span>{label}</span>
      <input className="field num !w-28 !px-2 !py-1.5 text-right !text-sm" inputMode="decimal" value={value > 0 ? value : ''} placeholder={placeholder} onChange={(e) => onChange(num(e.target.value))} aria-label={aria || label} />
    </label>
  );
}

/**
 * A share combination's order settings. `value` is { side: 'CE' | 'PE' | null, order: { risk, maxAmount, stopPct, target, exitMin } | null, steps: [...] | null }
 * (steps null = the Account profit lock, [] = none). `account` is { risk, maxAmount, steps, exitMin } for the placeholders.
 */
export function SharesOrderFields({ value, onChange, account = {} }) {
  const o = value.order || {};
  const put = (patch) => onChange({ ...value, ...patch });
  const setO = (k, v) => {
    const next = { ...o, [k]: v };
    if (!(Number(v) > 0)) delete next[k];
    put({ order: Object.keys(next).length ? next : null });
  };
  const exitMode = o.target > 0 ? 'target' : value.steps == null ? 'account' : value.steps.length ? 'own' : 'off';
  const first = value.steps?.[0];
  const start = first?.at ?? 400;
  const gap = first ? first.at - first.keep : 150;
  const setExit = (mode) => {
    const noTarget = { ...o };
    delete noTarget.target;
    const order = Object.keys(noTarget).length ? noTarget : null;
    if (mode === 'account') onChange({ ...value, order, steps: null });
    else if (mode === 'off') onChange({ ...value, order, steps: [] });
    else if (mode === 'own') onChange({ ...value, order, steps: [{ at: start, keep: Math.max(1, start - gap) }] });
    else onChange({ ...value, order: { ...o, target: o.target || 500 }, steps: null });
  };
  const ownRow = (at, room) => put({ steps: [{ at: Math.max(20, at), keep: Math.max(1, Math.max(20, at) - Math.min(Math.max(10, room), Math.max(20, at) - 1)) }] });
  const accountLock = account.steps?.length ? `from +${rs(account.steps[0].at)}` : 'none';
  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <div className="text-xs font-semibold">Trades</div>
        <Segmented className="w-full" size="sm" value={value.side || ''} onChange={(v) => put({ side: v || null })} options={[{ value: '', label: 'Buy and short' }, { value: 'CE', label: 'Buy only' }, { value: 'PE', label: 'Short only' }]} />
      </div>
      <Money label="Risk a trade, ₹ lost at the stop" value={o.risk} placeholder={`Account ${rs(account.risk)}`} onChange={(v) => setO('risk', v)} />
      <Money label="Most money in one trade, ₹" value={o.maxAmount} placeholder={`Account ${rs(account.maxAmount)}`} onChange={(v) => setO('maxAmount', v)} />
      <div className="space-y-1">
        <div className="text-xs font-semibold">Stop loss</div>
        <Segmented className="w-full" size="sm" value={o.stopPct > 0 ? 'pct' : 'chart'} onChange={(v) => setO('stopPct', v === 'pct' ? o.stopPct || 1 : 0)} options={[{ value: 'chart', label: 'Chart stop' }, { value: 'pct', label: '% from entry' }]} />
        {o.stopPct > 0 && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>Stop this % from the entry (0.3 to 5)</span>
            <input className="field num !w-20 !px-2 !py-1.5 text-right !text-sm" inputMode="decimal" value={o.stopPct} onChange={(e) => setO('stopPct', Math.min(5, num(e.target.value)) || 0.3)} aria-label="Stop percent" />
          </label>
        )}
        {!(o.stopPct > 0) && <p className="text-[11px] text-muted">Chart stop: under the last bars or the pattern level, never closer than 0.5% or 1 ATR.</p>}
      </div>
      <div className="space-y-1">
        <div className="text-xs font-semibold">Take profit</div>
        <Segmented className="w-full" size="sm" cols={2} value={exitMode} onChange={setExit} options={[{ value: 'account', label: `Account lock (${accountLock})` }, { value: 'own', label: 'Own lock' }, { value: 'target', label: 'Fixed target' }, { value: 'off', label: 'No lock' }]} />
        {exitMode === 'own' && (
          <div className="grid grid-cols-2 gap-2">
            <Money label="Lock from +₹" value={start} onChange={(v) => ownRow(v, gap)} />
            <Money label="Room ₹" value={gap} onChange={(v) => ownRow(start, v)} />
          </div>
        )}
        {exitMode === 'own' && <p className="text-[11px] text-muted">Once the profit reaches {rs(start)} the stop keeps {rs(start - gap)}, then follows {rs(gap)} behind the best profit.</p>}
        {exitMode === 'target' && <Money label="Sell at a profit of ₹" value={o.target} onChange={(v) => setO('target', v || 50)} />}
        {exitMode === 'off' && <p className="text-[11px] text-muted">No profit lock: only the stop and the closing time sell it.</p>}
      </div>
      <label className="flex items-center justify-between gap-3 text-xs text-muted">
        <span>Close its trades at (IST)</span>
        <select className="field num !w-36 !px-2 !py-1.5 !text-sm" value={o.exitMin || 0} onChange={(e) => setO('exitMin', Number(e.target.value))} aria-label="Time its trades close">
          <option value={0}>Account ({clock(account.exitMin || 915)})</option>
          {EXIT_TIMES.map((m) => <option key={m} value={m}>{clock(m)}</option>)}
        </select>
      </label>
    </div>
  );
}

/** An options combination's order settings: { side, stopMode, stopAtr, stopPoints, exits } (null = the shared one). */
export function OptionsOrderFields({ value, onChange }) {
  const put = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <div className="text-xs font-semibold">Buys</div>
        <Segmented className="w-full" size="sm" value={value.side || ''} onChange={(v) => put({ side: v || null })} options={[{ value: '', label: 'Calls and puts' }, { value: 'CE', label: 'Calls only' }, { value: 'PE', label: 'Puts only' }]} />
      </div>
      <div className="space-y-1">
        <div className="text-xs font-semibold">Stop loss</div>
        <Segmented className="w-full" size="sm" cols={3} value={value.stopMode || ''} onChange={(v) => put({ stopMode: v || null })} options={STOP_MODES} />
        {(value.stopMode === 'cap' || value.stopMode === 'atr') && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>ATRs (0.8 to 2.5)</span>
            <input className="field num !w-20 !px-2 !py-1.5 text-right !text-sm" inputMode="decimal" value={value.stopAtr ?? 2} onChange={(e) => put({ stopAtr: Math.min(2.5, Math.max(0.8, num(e.target.value) || 0.8)) })} aria-label="Stop in ATRs" />
          </label>
        )}
        {value.stopMode === 'fixed' && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>Index points from the entry (10 to 150)</span>
            <input className="field num !w-20 !px-2 !py-1.5 text-right !text-sm" inputMode="numeric" value={value.stopPoints ?? 30} onChange={(e) => put({ stopPoints: Math.min(150, Math.max(10, num(e.target.value) || 10)) })} aria-label="Stop in points" />
          </label>
        )}
      </div>
      <ExitsBlock exits={value.exits || undefined} onChange={(exits) => put({ exits: exits ?? null })} />
    </div>
  );
}

/** The editable part of a saved combination, as the Lab sends it. */
export function ordersOf(segment, c) {
  if (!c) return segment === 'shares' ? { side: null, order: null, steps: null } : { side: null, stopMode: null, exits: null };
  if (segment === 'shares') return { side: c.side ?? null, order: c.order ?? null, steps: c.exits && Array.isArray(c.exits.steps) ? c.exits.steps : null };
  return { side: c.side ?? null, stopMode: c.stopMode ?? null, ...(c.stopMode ? { stopAtr: c.stopAtr ?? 2, stopPoints: c.stopPoints ?? 30 } : {}), exits: c.exits ?? null };
}

/** A saved combination with the edited order settings put on it, ready for toPayload. */
export function applyOrders(segment, c, d) {
  if (segment === 'shares') return { ...c, side: d.side || undefined, order: d.order || undefined, exits: d.steps == null ? undefined : { steps: d.steps } };
  return { ...c, side: d.side || undefined, stopMode: d.stopMode || undefined, stopAtr: d.stopAtr, stopPoints: d.stopPoints, exits: d.exits || undefined };
}

/**
 * The Lab's order settings card: edit, "Test these" (re-runs the Lab with them, nothing saved), "Save to <combination>" and "Back to saved".
 * @param combo   the saved combination being tested, or null when the start is a single check (Save then adds it as a new combination)
 * @param check   { key, label } when the start is a single check
 */
export function LabOrders({ segment, combo, check = null, saved, account, testing, onTest, onSaved }) {
  const [draft, setDraft] = useState(() => ordersOf(segment, combo));
  const [busy, setBusy] = useState(false);
  const id = combo?.id ?? check?.key;
  useEffect(() => setDraft(ordersOf(segment, combo)), [segment, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changed = !same(draft, ordersOf(segment, combo));
  const endpoint = segment === 'shares' ? '/auto' : '/options';

  async function save() {
    if (!saved) return;
    setBusy(true);
    try {
      const list = saved.map((c, i) => toPayload(fromSaved(combo && c.id === combo.id ? applyOrders(segment, c, draft) : c), i));
      if (!combo && check) list.push(toPayload(applyOrders(segment, { name: check.label.slice(0, 60), conds: [check.key], need: 0, window: 3, on: false }, draft), list.length));
      await api(endpoint, { method: 'PUT', body: { combos: list } });
      toast.success(combo ? `Saved to ${combo.name}.${combo.on ? ' Live trades use them from the next entry.' : ''}` : 'Saved as a new combination, switched off. Turn it on under Account > Entries.');
      onSaved?.();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2.5 p-3">
      <div>
        <h3 className="text-sm font-semibold">Order settings{combo ? ` of ${combo.name}` : ''}</h3>
        <p className="text-[11px] leading-snug text-muted">
          Change how its trades are placed and closed, tap <b>Test these</b> to see the result here (nothing is saved), then save them to the combination so live trades use them too. Empty boxes use your Account settings.
        </p>
      </div>
      {segment === 'shares' ? <SharesOrderFields value={draft} onChange={setDraft} account={account} /> : <OptionsOrderFields value={draft} onChange={setDraft} />}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => onTest(draft)}>Test these</button>
        <button type="button" className="btn btn-sm" disabled={busy || !saved || (!changed && !!combo) || (!combo && saved.length >= 30)} onClick={save}>{combo ? `Save to ${combo.name.length > 16 ? 'combination' : combo.name}` : 'Save as new combination'}</button>
      </div>
      {(testing || changed) && (
        <button type="button" className="btn btn-sm w-full" onClick={() => { setDraft(ordersOf(segment, combo)); onTest(null); }}>
          Back to the saved settings
        </button>
      )}
      {testing && <p className="text-[11px] font-semibold text-accent">The result above uses these test settings, not the saved ones.</p>}
    </Card>
  );
}
