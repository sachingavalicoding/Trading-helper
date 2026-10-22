import { useEffect, useState } from 'react';
import { RefreshCw, ChevronDown, Check, X, Minus } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { formatPrice } from '../lib/format.js';
import { Card, Skeleton, Badge } from './ui.jsx';

const REFRESH_MS = 60_000;

const ACTION_STYLE = {
  BUY: { label: 'BUY', className: 'bg-up text-white' },
  SELL: { label: 'SELL', className: 'bg-down text-white' },
  NO_TRADE: { label: 'NO TRADE', className: 'bg-surface-2 text-fg' },
};

function VoteIcon({ vote }) {
  if (vote > 0) return <Check className="h-4 w-4 shrink-0 text-up" aria-label="bullish" />;
  if (vote < 0) return <X className="h-4 w-4 shrink-0 text-down" aria-label="bearish" />;
  return <Minus className="h-4 w-4 shrink-0 text-muted" aria-label="neutral" />;
}

function PlanCell({ label, value, note, tone = 'text-base' }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num font-bold ${tone}`}>{value}</div>
      {note && <div className="text-[11px] leading-tight text-muted">{note}</div>}
    </div>
  );
}

/**
 * Buy / Sell / No-trade read of the chart, refreshed every minute.
 * `onUsePlan(side, plan)` opens the order sheet with the suggested stop loss and target.
 */
export function SignalCard({ symbol, onUsePlan }) {
  const { data: s, loading, error, reload } = useApi(`/signals/${encodeURIComponent(symbol)}`, [symbol]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, [reload]);

  if (loading && !s) return <Skeleton className="h-36" />;
  if (error && !s) {
    return (
      <Card className="p-3 text-sm text-muted">
        Signal unavailable right now.{' '}
        <button type="button" onClick={reload} className="font-semibold text-accent">
          Try again
        </button>
      </Card>
    );
  }

  const style = ACTION_STYLE[s.action];
  const bulls = s.factors.filter((f) => f.vote > 0).length;
  const bears = s.factors.filter((f) => f.vote < 0).length;
  const updated = new Date(s.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Chart signal</h2>
        <button type="button" onClick={reload} aria-label="Refresh signal" className="-mr-1 flex items-center gap-1 rounded-lg p-1.5 text-[11px] text-muted hover:bg-surface-2">
          {updated} IST
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <span className={`rounded-xl px-3 py-2 text-lg font-extrabold tracking-wide ${style.className}`}>{style.label}</span>
        <div className="min-w-0">
          <div className="font-semibold leading-snug">{s.headline}</div>
          {s.maxScore > 0 && (
            <div className="text-xs text-muted">
              {bulls} bullish · {bears} bearish of {s.maxScore} checks{s.action !== 'NO_TRADE' ? ` · ${s.strength}` : ''}
            </div>
          )}
        </div>
      </div>

      {s.position && (
        <div className={`rounded-lg px-3 py-2 text-sm ${s.position.advice === 'HOLD' ? 'bg-accent/10' : 'bg-warn/15'}`}>
          <Badge tone={s.position.advice === 'HOLD' ? 'accent' : 'warn'}>{s.position.advice === 'HOLD' ? 'Hold' : 'Consider exit'}</Badge> <span className="align-middle">{s.position.text}</span>
        </div>
      )}

      {s.plan && (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-surface-2 p-3">
            <PlanCell label="Entry zone" value={`${formatPrice(s.plan.entryLow)} – ${formatPrice(s.plan.entryHigh)}`} tone="text-sm" />
            <PlanCell label="Reward : risk" value={`${s.plan.riskReward} : 1`} />
            <PlanCell label="Stop loss" value={formatPrice(s.plan.stopLoss)} note={s.plan.stopReason} tone="text-base text-down" />
            <PlanCell label="Target" value={formatPrice(s.plan.target)} note={s.plan.targetReason} tone="text-base text-up" />
          </div>
          {onUsePlan && (
            <button
              type="button"
              onClick={() => onUsePlan(s.action, s.plan)}
              className={`w-full rounded-xl py-2.5 text-sm font-bold text-white ${s.action === 'BUY' ? 'bg-up' : 'bg-down'}`}
            >
              {s.action === 'BUY' ? 'Buy' : 'Sell'} with this stop loss and target
            </button>
          )}
        </>
      )}

      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between text-sm font-semibold text-accent">
        Why?
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-3 text-sm">
          <ul className="space-y-1.5">
            {s.factors.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <VoteIcon vote={f.vote} />
                <span>
                  <span className="font-medium">{f.label}:</span> <span className="text-muted">{f.text}</span>
                </span>
              </li>
            ))}
          </ul>

          {(s.levels.supports.length > 0 || s.levels.resistances.length > 0) && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase text-muted">Resistance above</div>
                {s.levels.resistances.map((l) => (
                  <div key={l.price} className="num text-xs">
                    {formatPrice(l.price)} <span className="text-muted">{l.kind}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase text-muted">Support below</div>
                {s.levels.supports.map((l) => (
                  <div key={l.price} className="num text-xs">
                    {formatPrice(l.price)} <span className="text-muted">{l.kind}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {s.invalidation.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase text-muted">This idea is wrong if</div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {s.invalidation.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <p className="text-[11px] leading-snug text-muted">{s.disclaimer}</p>
    </Card>
  );
}
