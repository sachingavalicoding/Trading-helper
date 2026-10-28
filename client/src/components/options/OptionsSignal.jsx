import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { useMarket } from '../../context/MarketContext.jsx';
import { useOrderBlock } from '../../lib/orderGate.js';
import { formatPrice, formatINR, formatInt } from '../../lib/format.js';
import { scoreTone, shortExpiry } from '../../lib/options.js';
import { Badge, Card, Skeleton } from '../ui.jsx';

const SIDE = {
  CE: { title: 'Call (CE)', hint: 'pays if Nifty rises', icon: TrendingUp, tone: 'up' },
  PE: { title: 'Put (PE)', hint: 'pays if Nifty falls', icon: TrendingDown, tone: 'down' },
};

function ScoreBar({ score, minScore }) {
  const tone = scoreTone(score, minScore);
  const color = tone === 'up' ? 'bg-up' : tone === 'warn' ? 'bg-warn' : 'bg-surface-3';
  return (
    <div>
      <div className="relative h-2 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, score)}%` }} />
        <div className="absolute inset-y-0 w-px bg-fg/50" style={{ left: `${minScore}%` }} title={`Entry score ${minScore}`} />
      </div>
      <div className="num mt-1 flex justify-between text-[11px] text-muted">
        <span>
          Score <b className="text-fg">{score}</b> / 100
        </span>
        <span>entry at {minScore}</span>
      </div>
    </div>
  );
}

/** The plan the trader would place if you bought now: size, the stop and the profit lock from the Account tab. */
function PlanPreview({ preview }) {
  if (!preview) return null;
  if (preview.skipped) return <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">Would not buy now: {preview.skipped}.</p>;
  const p = preview.plan;
  const rs = (v) => `₹${formatInt(v)}`;
  return (
    <div className="space-y-1 rounded-lg bg-surface-2 p-2 text-xs">
      <div className="font-semibold text-fg">
        If you buy now: {p.lots} lot{p.lots > 1 ? 's' : ''} at ₹{formatPrice(p.premium)} ({rs(p.lots * p.lotSize * p.premium)})
      </div>
      <p className="num text-muted">
        <b className="text-fg">Stop:</b> {p.stopLoss != null ? `₹${formatPrice(p.stopLoss)} (−${p.lossPct}%), a loss of about ${rs(p.maxLoss)}` : 'none'}. It does not trail.
      </p>
      <p className="num text-muted">
        <b className="text-fg">Lock:</b> {p.lockStart > 0 ? `from +${rs(p.lockStart)} the stop keeps ${rs(p.lockStart - p.lockGap)}, then follows ${rs(p.lockGap)} behind the best profit` : 'off'}. No sale target.
      </p>
    </div>
  );
}

function SideCard({ side, contract, preview, best, minScore, busy, gate, onBuy }) {
  const [why, setWhy] = useState(false);
  const meta = SIDE[side.type];
  const Icon = meta.icon;
  const blocked = side.blocked || [];
  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Icon className={`h-4 w-4 ${meta.tone === 'up' ? 'text-up' : 'text-down'}`} /> {meta.title}
            {best && <Badge tone="up">Best now</Badge>}
          </h3>
          <p className="text-[11px] text-muted">{meta.hint}</p>
        </div>
        {contract && (
          <div className="num text-right text-xs">
            <div className="font-semibold">
              {contract.strike} · {shortExpiry(contract.expiry)}
            </div>
            <div className="text-muted">
              ₹{formatPrice(contract.ltp)} · lot {formatINR(contract.lotCost)}
            </div>
          </div>
        )}
      </div>
      <ScoreBar score={side.score} minScore={minScore} />
      {blocked.length > 0 ? (
        <ul className="space-y-1 text-xs text-down">
          {blocked.map((t) => (
            <li key={t}>✕ {t}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-up">✓ Every hard check passes.</p>
      )}
      {side.trigger && (
        <p className="text-xs text-muted">
          <b className="text-fg">{side.trigger.kind}:</b> {side.trigger.note}.
        </p>
      )}
      <p className="text-xs text-muted">
        <b className="text-fg">Chart stop:</b> Nifty {formatPrice(side.stop.price)} ({side.stop.note}).
        {side.levels.length > 0 && <> Next levels: {side.levels.map((l) => `${formatPrice(l.price)} ${l.kind}`).join(', ')}.</>}
      </p>
      <PlanPreview preview={preview} />
      <button type="button" onClick={() => setWhy((v) => !v)} className="flex items-center gap-1 text-xs text-accent">
        {why ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} Why this score
      </button>
      {why && (
        <ul className="divide-y divide-line text-xs">
          {side.checks.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-2 py-1">
              <span className="min-w-0 text-muted">
                <b className="text-fg">{c.label}:</b> {c.text}
              </span>
              <span className={`num shrink-0 ${c.points >= c.max ? 'text-up' : c.points > 0 ? 'text-warn' : 'text-muted'}`}>
                {c.points}/{c.max}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy || !contract?.ltp || Boolean(gate)} onClick={() => onBuy(side.type, contract, preview)} className={`btn btn-lg w-full ${meta.tone === 'up' ? 'btn-buy' : 'btn-sell'}`}>
        {gate || `Buy ${preview?.plan?.lots ?? 1} lot${(preview?.plan?.lots ?? 1) > 1 ? 's' : ''} ${side.type} (paper)`}
      </button>
    </Card>
  );
}

/** The Nifty chart read for both sides, with a way to take either one by hand using the same stop and profit lock the auto trader uses. */
export function OptionsSignal({ minScore, onBought }) {
  const { data, reload } = useApi('/options/read', []);
  const { refresh } = useMarket();
  const [busy, setBusy] = useState(false);
  const blocked = useOrderBlock();

  useEffect(() => {
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [reload]);

  async function buy(type, contract, preview) {
    const lots = preview?.plan?.lots ?? 1;
    const cost = formatINR(contract.lotCost * lots);
    if (!window.confirm(`Buy ${lots} lot${lots > 1 ? 's' : ''} of ${contract.label} for about ${cost} (paper money)? The stop and profit lock come from your Account tab.`)) return;
    setBusy(true);
    try {
      const { plan } = await api('/options/buy', { method: 'POST', body: { type, lots } });
      toast.success(`Bought ${plan.lots} lot ${plan.type}: stop ₹${formatPrice(plan.stopLoss)} (−${plan.lossPct}%)`);
      refresh?.();
      onBought?.();
    } catch (e) {
      toast.error(e.message || 'Could not buy');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Skeleton className="h-64 w-full" />;
  if (!data.ready) return <Card className="p-4 text-sm text-muted">The Nifty chart is still loading. Give it a minute after the server starts.</Card>;
  const lead = data.best ? SIDE[data.best].title : null;
  return (
    <div className="space-y-3">
      <Card className="p-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-xs text-muted">Nifty 50 now</div>
          <div className="num text-lg font-bold">{formatPrice(data.spot)}</div>
        </div>
        <p className={`mt-1 text-sm font-medium ${lead ? 'text-up' : 'text-muted'}`}>
          {lead ? `${lead} has a clean setup.` : 'No clean setup right now. Waiting is a position too.'}
        </p>
        <p className="num mt-1 text-[11px] text-muted">
          ATR(5m) {data.atr5} · ADX {data.snapshot.adx ?? '–'} · RSI {data.snapshot.rsi ?? '–'} · choppiness {data.snapshot.chop ?? '–'} · breadth {data.snapshot.breadthUp == null ? '–' : `${Math.round(data.snapshot.breadthUp * 100)}% up`} · range today {data.snapshot.dayRangePct}%
          {data.snapshot.avgRangePct ? ` of ${data.snapshot.avgRangePct}%` : ''}
        </p>
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        {['ce', 'pe'].map((k) => (
          <SideCard key={k} side={data[k]} contract={data.contracts[k.toUpperCase()]} preview={data.preview?.[k.toUpperCase()]} best={data.best === k.toUpperCase()} minScore={minScore} busy={busy} gate={blocked} onBuy={buy} />
        ))}
      </div>
    </div>
  );
}
