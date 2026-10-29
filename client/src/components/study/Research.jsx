import { useState } from 'react';
import { Microscope } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { VERDICT } from '../../lib/combos.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { GROUPS, applyRequests, applyText } from '../../lib/research.js';
import { Badge, Card, Segmented } from '../ui.jsx';

const part = (p) => (p ? `${p.trades} trades · ${formatPnl(p.net)}` : '–');

function Line({ x, split, onApply, busy }) {
  const v = VERDICT[x.verdict];
  return (
    <li className="space-y-0.5 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 font-semibold">
          {x.label} {x.current && <Badge tone="accent">Yours</Badge>} {v && <Badge tone={v.tone}>{v.text}</Badge>}
        </span>
        <span className={`num shrink-0 text-sm font-bold ${pnlClass(x.net)}`}>{formatPnl(x.net)}</span>
      </div>
      <p className="num text-[11px] text-muted">
        {x.trades} trades · {x.winRate ?? '–'}% win · worst {formatPnl(x.worst)} · drawdown {formatPnl(-x.maxDrawdown)}
        {split && ` · older ${part(x.train)} · newer ${part(x.test)}`}
      </p>
      {x.text && <p className="text-[11px] leading-snug text-muted">{x.text}</p>}
      {x.apply && !x.current && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onApply(x.apply)}>
          Use this
        </button>
      )}
    </li>
  );
}

/**
 * The research on the exits: the same Breakout + Engulfing entries traded with other stop amounts, profit ladders and trailing stops.
 * "Use this" saves the setting in Account > Limits; nothing changes until you tap it.
 */
export function Research({ r, onApplied }) {
  const [group, setGroup] = useState('stop');
  const [busy, setBusy] = useState(false);
  if (!r) return null;

  async function apply(a) {
    if (!window.confirm(`Save this for new trades?\n\n${applyText(a)}`)) return;
    setBusy(true);
    try {
      for (const q of applyRequests(a)) await api(q.path, { method: 'PUT', body: q.body });
      toast.success('Saved. New trades use it.');
      onApplied?.();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2 border-accent2/40 p-3">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-accent2">
          <Microscope className="h-4 w-4" /> Research: stop and profit ladder
        </h3>
        {r.skipped ? (
          <p className="text-[11px] leading-snug text-muted">Not run: {r.skipped}.</p>
        ) : (
          <p className="text-[11px] leading-snug text-muted">
            The same entries ({r.entries}, {r.signals} signals) traded again with other exits. Each row changes <b className="text-fg">one thing</b> from your settings now. {r.split ? 'Older and newer days are shown separately: trust a row that earns on both.' : 'Run 15 days or more to see older and newer days apart.'} Tap Use this to save one; nothing changes until you do.
          </p>
        )}
      </div>
      {!r.skipped && (
        <>
          <div className="rounded-lg bg-surface-2 p-2 text-xs">
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold">Your settings now</span>
              <span className={`num text-sm font-bold ${pnlClass(r.base.net)}`}>{formatPnl(r.base.net)}</span>
            </div>
            <p className="num text-[11px] text-muted">
              {r.base.trades} trades · {r.base.winRate ?? '–'}% win · drawdown {formatPnl(-r.base.maxDrawdown)}
              {r.split && ` · older ${part(r.base.train)} · newer ${part(r.base.test)}`}
            </p>
          </div>
          {r.mix && (
            <div className="space-y-1 rounded-lg border border-accent2/40 p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold">{r.mix.label}</span>
                <span className={`num text-sm font-bold ${pnlClass(r.mix.net)}`}>{formatPnl(r.mix.net)}</span>
              </div>
              <p className="text-[11px] leading-snug text-muted">{r.mix.text}</p>
              <p className="num text-[11px] text-muted">
                {r.mix.trades} trades · {r.mix.winRate ?? '–'}% win · drawdown {formatPnl(-r.mix.maxDrawdown)} · older {part(r.mix.train)} · newer {part(r.mix.test)}
              </p>
              <p className="text-[11px] leading-snug text-muted">Would save: {applyText(r.mix.apply)}.</p>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => apply(r.mix.apply)}>
                Use this mix
              </button>
            </div>
          )}
          {!r.mix && r.split && <p className="rounded-lg bg-surface-2 p-2 text-[11px] leading-snug text-muted">No change beat your settings on the older days, so there is no mix to suggest. That is a real answer: your settings are already good for these entries.</p>}
          <Segmented className="w-full" size="sm" value={group} onChange={setGroup} options={GROUPS} />
          <ul className="divide-y divide-line">
            {r.rows
              .filter((x) => x.group === group)
              .map((x) => (
                <Line key={x.key} x={x} split={r.split} onApply={apply} busy={busy} />
              ))}
          </ul>
          <p className="text-[11px] leading-snug text-muted">About 30 settings were tried on one stretch of days, so the top one can be partly luck. A setting that wins on the older days and the newer days is far more believable than one that wins on a single stretch.</p>
        </>
      )}
    </Card>
  );
}
