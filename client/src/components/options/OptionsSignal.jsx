import { useEffect, useState } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { useMarket } from '../../context/MarketContext.jsx';
import { useOrderBlock } from '../../lib/orderGate.js';
import { formatPrice, formatINR, formatInt } from '../../lib/format.js';
import { shortExpiry } from '../../lib/options.js';
import { indexOf } from '../../lib/indexes.js';
import { Card, Skeleton } from '../ui.jsx';
import { OrderBook } from './OrderBook.jsx';

const SIDE = {
  CE: { title: 'Call (CE)', hint: 'pays if it rises', icon: TrendingUp, tone: 'up' },
  PE: { title: 'Put (PE)', hint: 'pays if it falls', icon: TrendingDown, tone: 'down' },
};

/** The plan the trader would place if you bought now: size, the chart stop, the loss and the profit lock from the Account tab. */
function PlanPreview({ preview, type, name }) {
  if (!preview) return null;
  if (preview.skipped) return <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">Would not buy now: {preview.skipped}.</p>;
  const p = preview.plan;
  const rs = (v) => `₹${formatInt(v)}`;
  const way = type === 'CE' ? 'at or below' : 'at or above';
  return (
    <div className="space-y-1 rounded-lg bg-surface-2 p-2 text-xs">
      <div className="font-semibold text-fg">
        If you buy now: {p.lots} lot{p.lots > 1 ? 's' : ''} at ₹{formatPrice(p.premium)} ({rs(p.lots * p.lotSize * p.premium)})
      </div>
      <p className="text-muted">
        <b className="text-fg">Exit:</b> sells when a 1-minute {name} candle closes {way} {formatPrice(p.stopSpot)} ({p.stopNote}).
        {p.stopLoss != null ? ` Hard stop at premium ₹${formatPrice(p.stopLoss)} for a fast fall.` : ''}
      </p>
      <p className="num text-muted">
        <b className="text-fg">Loss:</b> about {rs(p.maxLoss)} at the {name} stop{p.worstCase != null ? `, at most ${rs(p.worstCase)} if only the hard stop works` : ''}.
      </p>
      <p className="num text-muted">
        <b className="text-fg">Lock:</b> {p.lockSteps?.length > 1 ? `your ladder: ${p.lockSteps.map((r) => `+${rs(r.at)} keeps ${rs(r.keep)}`).join(', ')}, and above a row the stop follows that row's gap behind the best profit` : p.lockStart > 0 ? `from +${rs(p.lockStart)} the stop keeps ${rs(p.lockStart - p.lockGap)}, then follows ${rs(p.lockGap)} behind the best profit` : 'off'}. No sale target.
      </p>
    </div>
  );
}

/**
 * The indicator score of one side: the 15 chart checks added up. It is the score the "Indicator score" entry buys on, and the same number the
 * pattern and combination "minimum score" settings read. Says whether the score entry would buy this side now, and lists every check.
 */
function ScoreBlock({ side, mode, best }) {
  const [open, setOpen] = useState(false);
  const score = Math.round(side.score);
  const min = mode?.minScore ?? 70;
  let status;
  if (!mode?.on) status = 'The Indicator score entry is off (Account > Entries), so this score only filters patterns and combinations that have a minimum score.';
  else if (best === side.type) status = score >= min ? `At or above your ${min}, the stronger side and nothing blocks it: the bot buys this side if your limits allow.` : `The stronger side, but under your ${min}: no buy yet.`;
  else if (side.blocked?.length) status = `Not bought: ${side.blocked[0]}.`;
  else if (score >= min) status = 'High enough, but the other side scores within 10 points, so the bot waits.';
  else status = `Under your ${min}: no buy.`;
  return (
    <div className="space-y-1 rounded-lg bg-surface-2 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span><b className="text-fg">Indicator score</b> <span className="text-muted">(15 indicators)</span></span>
        <span className={`num text-sm font-bold ${mode?.on && score >= min ? 'text-up' : ''}`}>{score} <span className="text-[11px] font-normal text-muted">/ 100{mode?.on ? ` · buys at ${min}+` : ''}</span></span>
      </div>
      <p className="text-[11px] leading-snug text-muted">{status}</p>
      {side.checks?.length > 0 && (
        <>
          <button type="button" className="text-[11px] font-semibold text-accent" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} the indicators</button>
          {open && (
            <ul className="divide-y divide-line">
              {side.checks.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-2 py-1 text-[11px] leading-snug">
                  <span className="min-w-0"><b>{c.label}</b> <span className="text-muted">{c.text}</span></span>
                  <span className={`num shrink-0 ${c.points > 0 ? 'text-up' : 'text-muted'}`}>{c.points}/{c.max}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function SideCard({ side, contract, preview, name, busy, gate, onBuy, mode, best }) {
  const meta = SIDE[side.type];
  const Icon = meta.icon;
  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Icon className={`h-4 w-4 ${meta.tone === 'up' ? 'text-up' : 'text-down'}`} /> {meta.title}
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
      {side.score != null && <ScoreBlock side={side} mode={mode} best={best} />}
      {side.trigger && (
        <p className="text-xs text-muted">
          <b className="text-fg">{side.trigger.kind}:</b> {side.trigger.note}.
        </p>
      )}
      <p className="text-xs text-muted">
        <b className="text-fg">Chart stop:</b> {name} {formatPrice(side.stop.price)} ({side.stop.note}).
        {side.levels.length > 0 && <> Next levels: {side.levels.map((l) => `${formatPrice(l.price)} ${l.kind}`).join(', ')}.</>}
      </p>
      <PlanPreview preview={preview} type={side.type} name={name} />
      <button type="button" disabled={busy || !contract?.ltp || Boolean(gate)} onClick={() => onBuy(side.type, contract, preview)} className={`btn btn-lg w-full ${meta.tone === 'up' ? 'btn-buy' : 'btn-sell'}`}>
        {gate || `Buy ${preview?.plan?.lots ?? 1} lot${(preview?.plan?.lots ?? 1) > 1 ? 's' : ''} ${side.type} (paper)`}
      </button>
    </Card>
  );
}

/** The chart read of one index for both sides, with a way to take either one by hand using the same stop and profit lock the auto trader uses. */
export function OptionsSignal({ index = 'NIFTY', onBought }) {
  const idx = indexOf(index);
  const { data, reload } = useApi(`/options/read?index=${index}`, []);
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
    if (!window.confirm(`Buy ${lots} lot${lots > 1 ? 's' : ''} of ${contract.label} for about ${cost} (paper money)? It sells if the ${idx.short} chart level breaks; the loss limit and profit lock come from your Account tab.`)) return;
    setBusy(true);
    try {
      const { plan } = await api('/options/buy', { method: 'POST', body: { type, lots, index } });
      toast.success(`Bought ${plan.lots} lot ${plan.type}: loss about ₹${formatInt(plan.maxLoss)} at the chart stop`);
      refresh?.();
      onBought?.();
    } catch (e) {
      toast.error(e.message || 'Could not buy');
    } finally {
      setBusy(false);
    }
  }

  if (!data || (data.index && data.index !== index)) return <Skeleton className="h-64 w-full" />;
  if (!data.ready) return <Card className="p-4 text-sm text-muted">The {idx.short} chart is still loading. Give it a minute after the server starts.</Card>;
  return (
    <div className="space-y-3">
      <Card className="p-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-xs text-muted">{idx.name} now</div>
          <div className="num text-lg font-bold">{formatPrice(data.spot)}</div>
        </div>
        <p className="num mt-1 text-[11px] text-muted">
          ATR(5m) {data.atr5} · ADX {data.snapshot.adx ?? '–'} · RSI {data.snapshot.rsi ?? '–'} · choppiness {data.snapshot.chop ?? '–'} · breadth {data.snapshot.breadthUp == null ? '–' : `${Math.round(data.snapshot.breadthUp * 100)}% up`} · range today {data.snapshot.dayRangePct}%
          {data.snapshot.avgRangePct ? ` of ${data.snapshot.avgRangePct}%` : ''}
        </p>
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        {['ce', 'pe'].map((k) => (
          <SideCard key={k} side={data[k]} contract={data.contracts[k.toUpperCase()]} preview={data.preview?.[k.toUpperCase()]} mode={data.scoreMode} best={data.best} name={idx.short} busy={busy} gate={blocked} onBuy={buy} />
        ))}
      </div>
      <OrderBook contracts={data.contracts} />
    </div>
  );
}
