import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { TRAIL_POINTS, trailText } from '../../lib/stops.js';
import { Segmented } from '../ui.jsx';

const choices = (now) => (TRAIL_POINTS.includes(now) ? TRAIL_POINTS : [...TRAIL_POINTS, now].sort((a, b) => a - b));

/**
 * Account > Limits > Options: the trailing stop in Nifty points. Once the index has moved the start distance your way, the chart stop
 * follows the best price by the points you pick and never moves back. The sale is still on a closed 1-minute candle beyond the stop.
 */
export function TrailStop({ data, reload }) {
  const [busy, setBusy] = useState(false);
  const s = data.settings;
  const on = s.trailMode === 'points';

  async function save(patch) {
    setBusy(true);
    try {
      await api('/options', { method: 'PUT', body: patch });
      reload();
      toast.success('Saved. New trades use it.');
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const select = (label, key) => (
    <label className="flex items-center justify-between gap-3 text-xs text-muted">
      <span>{label}</span>
      <select className="field num !w-24 !px-2 !py-1.5 !text-sm" value={s[key]} disabled={busy} onChange={(e) => save({ [key]: Number(e.target.value) })} aria-label={label}>
        {choices(s[key]).map((p) => (
          <option key={p} value={p}>
            {p} pts
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="text-sm font-semibold">Options: trailing stop</div>
      <Segmented className="w-full" size="sm" value={s.trailMode} onChange={(v) => save({ trailMode: v })} options={[{ value: 'off', label: 'Off' }, { value: 'points', label: 'Follow in points' }]} />
      {on && (
        <>
          {select('Starts after Nifty moves this far your way', 'trailStart')}
          {select('Stop stays this far behind the best price', 'trailPoints')}
        </>
      )}
      <p className="text-[11px] leading-snug text-muted">
        {on
          ? `A call: once Nifty is ${s.trailStart} points above your entry, the stop sits ${s.trailPoints} points under the highest price and rises with it. A put is the same upside down. It never moves back, and it works together with your profit ladder (whichever sells first). The trade is sold when a 1-minute candle closes beyond the stop.`
          : 'Off: the stop stays at the chart level until your profit ladder takes over. Switch it on to make the stop follow the price.'}
      </p>
      {on && <p className="text-[11px] leading-snug text-muted">Now: {trailText({ points: s.trailPoints, start: s.trailStart })}. A trade already open keeps the setting it started with.</p>}
    </div>
  );
}
