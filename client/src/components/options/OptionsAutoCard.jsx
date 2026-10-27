import { useState } from 'react';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { formatPrice, pnlClass } from '../../lib/format.js';
import { Badge, Card } from '../ui.jsx';
import { LockLadderEditor } from '../LockLadderEditor.jsx';

const FIELDS = [
  { key: 'budget', label: 'Money set aside for options (₹)', step: 1000, min: 5000, max: 100000000 },
  { key: 'maxLossPct', label: 'Most one trade may lose (% of that money)', step: 0.5, min: 1, max: 20 },
  { key: 'maxLots', label: 'Most lots in one trade', step: 1, min: 1, max: 20 },
  { key: 'maxTrades', label: 'Most trades a day', step: 1, min: 1, max: 10 },
  { key: 'dailyLossPct', label: 'Stop for the day after losing (%)', step: 1, min: 2, max: 30 },
  { key: 'minScore', label: 'Minimum score', step: 5, min: 60, max: 100 },
  { key: 'trailPct', label: 'Trailing stop (% of premium, 0 = off)', step: 5, min: 0, max: 60 },
];

/** Switch for the paper options trader and its limits. Paper money only. */
export function OptionsAutoCard({ data, reload }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const s = data.settings;

  async function save(patch) {
    setBusy(true);
    try {
      await api('/options', { method: 'PUT', body: patch });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Bot className="h-4 w-4 text-accent" /> Auto paper options
            <Badge tone={s.enabled ? 'up' : 'muted'}>{s.enabled ? 'On' : 'Off'}</Badge>
          </h2>
          <p className="num text-xs text-muted">
            Today: {data.today.trades} trades · {data.today.open} open · <span className={pnlClass(data.today.pnl)}>₹{formatPrice(data.today.pnl)}</span>
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          aria-label="Auto paper options"
          disabled={busy}
          onClick={() => save({ enabled: !s.enabled })}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${s.enabled ? 'bg-accent' : 'bg-surface-3'}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      <p className="text-[11px] leading-snug text-muted">
        Buys one Nifty at-the-money call or put when the chart is clear. The stop is the premium at the chart's invalidation level, the stop climbs to 80% of the way to each target, a profit lock ladder and a trailing stop follow, and everything is closed by 15:00.
      </p>
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-accent">
        {open ? 'Hide limits' : 'Change limits'}
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="text-[11px] text-muted">
              {f.label}
              <input
                type="number"
                inputMode="decimal"
                defaultValue={s[f.key]}
                step={f.step}
                min={f.min}
                max={f.max}
                onBlur={(e) => e.target.value !== '' && Number(e.target.value) !== s[f.key] && save({ [f.key]: Number(e.target.value) })}
                className="num mt-0.5 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
              />
            </label>
          ))}
          <LockLadderEditor
            title="Profit lock ladder (options)"
            hint="When the profit reaches a rung (₹ per lot, so two lots lock twice as much), the stop moves up to keep the second number, then trails behind the best profit by the difference."
            unit="rupee"
            rows={s.lockLadder}
            defaults={data.defaultLockLadder}
            busy={busy}
            onSave={(rows) => save({ lockLadder: rows })}
          />
        </div>
      )}
      <p className="text-[11px] leading-snug text-muted">{data.disclaimer}</p>
    </Card>
  );
}
