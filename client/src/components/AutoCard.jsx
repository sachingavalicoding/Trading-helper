import { useState } from 'react';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { formatPrice, pnlClass } from '../lib/format.js';
import { Badge, Card, Skeleton } from './ui.jsx';

const FIELDS = [
  { key: 'maxShares', label: 'Max shares per trade (0 = auto)', step: 1, min: 0, max: 100000 },
  { key: 'maxTradeAmount', label: 'Max ₹ per trade', step: 1000, min: 1000, max: 100000000 },
  { key: 'minScore', label: 'Minimum score', step: 5, min: 60, max: 100 },
  { key: 'maxOpen', label: 'Max open trades', step: 1, min: 1, max: 10 },
  { key: 'riskPct', label: 'Risk per trade (%)', step: 0.25, min: 0.25, max: 3 },
  { key: 'dailyLossPct', label: 'Stop for the day after losing (%)', step: 0.5, min: 0.5, max: 10 },
];

/** Switch for the paper auto-trader: it places VIRTUAL orders from scanner ideas, nothing real. */
export function AutoCard() {
  const { data, reload } = useApi('/auto', []);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (!data) return <Skeleton className="h-20" />;
  const s = data.settings;

  async function save(patch) {
    setBusy(true);
    try {
      await api('/auto', { method: 'PUT', body: patch });
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
            <Bot className="h-4 w-4 text-accent" /> Auto paper trading
            <Badge tone={s.enabled ? 'up' : 'muted'}>{s.enabled ? 'On' : 'Off'}</Badge>
          </h2>
          <p className="num text-xs text-muted">
            Today: {data.today.trades} trades · {data.today.open} open ·{' '}
            <span className={pnlClass(data.today.pnl)}>₹{formatPrice(data.today.pnl)}</span>
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          aria-label="Auto paper trading"
          disabled={busy}
          onClick={() => save({ enabled: !s.enabled })}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${s.enabled ? 'bg-up' : 'bg-surface-2'}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>
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
        </div>
      )}
      <p className="text-[11px] leading-snug text-muted">{data.disclaimer}</p>
    </Card>
  );
}
