import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { VERDICT } from '../../lib/combos.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { applyRequests, applyText } from '../../lib/research.js';
import { Badge } from '../ui.jsx';

const part = (p) => (p ? `${p.trades} trades · ${formatPnl(p.net)}` : '–');
const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

function Row({ x, split, onApply, busy, canApply }) {
  const v = VERDICT[x.verdict];
  return (
    <li className="space-y-0.5 py-1.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 font-semibold">
          {x.label.replace(/^Stop at /, '')} {x.current && <Badge tone="accent">Now</Badge>} {v && <Badge tone={v.tone}>{v.text}</Badge>}
        </span>
        <span className={`num shrink-0 font-bold ${pnlClass(x.net)}`}>{formatPnl(x.net)}</span>
      </div>
      <p className="num text-[11px] text-muted">
        {x.trades} trades · {x.winRate ?? '–'}% win · worst {formatPnl(x.worst)}
        {split && ` · older ${part(x.train)} · newer ${part(x.test)}`}
      </p>
      {canApply && x.apply && !x.current && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onApply(x.apply)}>
          Use this
        </button>
      )}
    </li>
  );
}

/**
 * The research on one combination (or one added check): where its stop should go, how far its winners went against it, and the best exits.
 * `own` is true for a saved combination, whose stop can be set from here; for an added check the stop comes with Add.
 */
export function ComboResearch({ r, own = false, onApplied }) {
  const [busy, setBusy] = useState(false);
  if (!r) return null;

  async function apply(a) {
    if (!window.confirm(`Save this for new trades?\n\n${applyText(a)}`)) return;
    setBusy(true);
    try {
      const combos = a.comboStop ? (await api('/options')).settings.combos : [];
      for (const q of applyRequests(a, { combos })) await api(q.path, { method: 'PUT', body: q.body });
      toast.success('Saved. New trades use it.');
      onApplied?.();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const adv = r.adverse;
  return (
    <details className="rounded-lg border border-line">
      <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-semibold text-accent">Stop and exits for this ({r.signals} signals)</summary>
      <div className="space-y-2 p-2">
        {adv ? (
          <p className="rounded-lg bg-surface-2 p-2 text-[11px] leading-snug text-muted">
            <b className="text-fg">How far its winners went against it.</b> Of {adv.trades} trades {adv.winners} won. Per lot, they were down at most {rs(adv.p50)} half the time, {rs(adv.p80)} 80% of the time, {rs(adv.p90)} 90% of the time and {rs(adv.max)} at the worst before they came back. A stop beyond the 90% figure would rarely have been touched by a winner.
          </p>
        ) : (
          <p className="text-[11px] text-muted">Too few winners to say how far they went against it.</p>
        )}
        <div>
          <div className="text-[11px] font-semibold">Where the stop goes</div>
          <ul className="divide-y divide-line">
            {r.stops.map((x) => (
              <Row key={x.key} x={x} split={r.split} busy={busy} onApply={apply} canApply={own} />
            ))}
          </ul>
        </div>
        {r.exits.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold">Best profit settings</div>
            <ul className="divide-y divide-line">
              {r.exits.map((x) => (
                <Row key={x.key} x={x} split={r.split} busy={busy} onApply={apply} canApply />
              ))}
            </ul>
          </div>
        )}
        {r.mix && (
          <div className="space-y-1 rounded-lg border border-accent2/40 p-2 text-xs">
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold">{r.mix.label}</span>
              <span className={`num font-bold ${pnlClass(r.mix.net)}`}>{formatPnl(r.mix.net)}</span>
            </div>
            <p className="text-[11px] leading-snug text-muted">{r.mix.text}</p>
            <p className="num text-[11px] text-muted">
              {r.mix.trades} trades · {r.mix.winRate ?? '–'}% win · older {part(r.mix.train)} · newer {part(r.mix.test)}
            </p>
            {own && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => apply(r.mix.apply)}>
                Use this mix
              </button>
            )}
          </div>
        )}
        <p className="text-[11px] leading-snug text-muted">The stop is the one most worth getting right, but about 40 settings were tried on one stretch of days: trust a row that earns on both the older and the newer days. Profit settings (ladder, trail, break-even) are shared by every entry; the stop can be set per combination.</p>
      </div>
    </details>
  );
}
