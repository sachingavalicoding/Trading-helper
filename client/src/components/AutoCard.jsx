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
  { key: 'dailyLossPct', label: 'Stop for the day after losing (%)', step: 0.5, min: 0.5, max: 10 },
];

/** Switch for the paper auto-trader: it places VIRTUAL orders from scanner ideas, nothing real. */
export function AutoCard() {
  const { data, reload } = useApi('/auto', []);
  const [busy, setBusy] = useState(false);
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
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${s.enabled ? 'bg-accent' : 'bg-surface-3'}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      <AutoLog />
      <p className="text-[11px] leading-snug text-muted">{data.disclaimer}</p>
    </Card>
  );
}

/** The limits of the share auto-trader. They live in the Account tab, next to the stop and profit lock. */
export function AutoLimits() {
  const { data, reload } = useApi('/auto', []);
  const [busy, setBusy] = useState(false);
  if (!data) return <Skeleton className="h-28" />;
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
      <label className="col-span-2 flex items-center justify-between gap-2 rounded-lg border border-line px-2 py-1.5 text-[11px] text-muted">
        Also take news-gap trades from 09:20
        <input type="checkbox" checked={s.earlyNews !== false} disabled={busy} onChange={(e) => save({ earlyNews: e.target.checked })} className="h-4 w-4 accent-[var(--color-accent)]" />
      </label>
    </div>
  );
}

const EXIT_LABEL = { STOP: 'Stopped', LOCK: 'Locked profit', TARGET: 'Target', MANUAL: 'Manual exit', SQUARE_OFF: 'Square-off', TIME: 'Time exit' };

/** Every decision the auto-trader made today with its reason and result, to review in the evening. */
function AutoLog() {
  const [show, setShow] = useState(false);
  const { data } = useApi(show ? '/auto/log' : null, [show]);
  const sum = data?.summary;
  return (
    <div className="border-t border-line pt-2">
      <button type="button" onClick={() => setShow((o) => !o)} className="text-xs text-accent">
        {show ? 'Hide auto log' : "Today's auto log"}
      </button>
      {show && !data && <Skeleton className="mt-2 h-16" />}
      {show && sum && (
        <div className="mt-2 space-y-2 text-xs">
          <p className="num text-muted">
            {sum.placed} placed · {sum.skipped} skipped · {sum.wins} won · {sum.losses} lost · net{' '}
            <span className={pnlClass(sum.netPnl)}>₹{formatPrice(sum.netPnl)}</span> (charges ₹{formatPrice(sum.charges)})
            {sum.gaveBack > 0 && ` · ${sum.gaveBack} were in profit first, then lost`}
          </p>
          {sum.byExit.length > 0 && (
            <p className="num text-muted">
              {sum.byExit.map((g) => `${EXIT_LABEL[g.key] || g.key} ${g.trades} (₹${formatPrice(g.netPnl)})`).join(' · ')}
            </p>
          )}
          {sum.skipReasons.length > 0 && <p className="text-muted">Skipped because: {sum.skipReasons.map((r) => `${r.example} ×${r.count}`).join(' · ')}</p>}
          {sum.skippedHindsight.followed > 0 && (
            <p className="text-muted">
              Of the skipped ideas, {sum.skippedHindsight.wouldHitTarget} later hit target 1 and {sum.skippedHindsight.wouldStop} hit the stop.
            </p>
          )}
          <ul className="divide-y divide-line">
            {data.entries.map((e) => (
              <li key={e._id} className="flex items-start justify-between gap-2 py-1.5">
                <div className="min-w-0">
                  <p className="font-medium">
                    {e.symbol} {e.side} <span className="text-muted">· {e.setup || 'idea'} · score {e.score}</span>
                  </p>
                  <p className="text-muted">
                    {e.decision === 'SKIPPED' ? `Skipped: ${e.reason}` : e.status === 'OPEN' ? `Open · ${e.qty} @ ₹${formatPrice(e.fillPrice)}` : `${EXIT_LABEL[e.outcome.exitReason]} · ${e.qty} @ ₹${formatPrice(e.fillPrice)} → ₹${formatPrice(e.outcome.exitPrice)} · ${e.outcome.minutesHeld}m · best ${e.outcome.bestR ?? '–'}R / worst ${e.outcome.worstR ?? '–'}R`}
                  </p>
                </div>
                {e.outcome && <span className={`num shrink-0 ${pnlClass(e.outcome.netPnl)}`}>₹{formatPrice(e.outcome.netPnl)}</span>}
              </li>
            ))}
          </ul>
          {data.entries.length === 0 && <p className="text-muted">No decisions yet today.</p>}
        </div>
      )}
    </div>
  );
}
