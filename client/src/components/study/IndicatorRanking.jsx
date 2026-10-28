import { useState } from 'react';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { VERDICT } from '../../lib/combos.js';
import { Badge, Card, Segmented } from '../ui.jsx';

const SHOW = 12;
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'Keep', label: 'Keep' },
  { value: 'Unsteady', label: 'Unsteady' },
  { value: 'Drop', label: 'Drop' },
];

/**
 * Every check of the combination builder on its own: each time it turned true a trade was taken, with the same exits as the rest of the study.
 * Keep = made money in both halves of the period; Drop = lost money. Build combinations from the keepers.
 * `callWord` / `putWord` name the two sides ("Calls"/"Puts" for options, "Buys"/"Sells" for shares).
 */
export function IndicatorRanking({ rows, skipped = [], callWord = 'Calls', putWord = 'Puts' }) {
  const [filter, setFilter] = useState('all');
  const [all, setAll] = useState(false);
  if (!rows?.length && !skipped.length) return null;
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const shown = rows.filter((r) => filter === 'all' || r.verdict === filter);
  const list = all ? shown : shown.slice(0, SHOW);
  return (
    <Card className="space-y-2 p-3">
      <div>
        <h3 className="text-sm font-semibold">Indicators on their own ({rows.length})</h3>
        <p className="text-[11px] leading-snug text-muted">
          A trade each time the check turns true. <b className="text-up">Keep</b> made money in both halves of the period ({count('Keep')}), <b className="text-warn">Unsteady</b> won overall but lost in one half ({count('Unsteady')}), <b className="text-down">Drop</b> lost money ({count('Drop')}). Under 15 trades says nothing. With this many checks a few will look good by luck alone, so treat Keep as a shortlist to try, not as proof.
        </p>
      </div>
      {skipped.map((s) => (
        <p key={s.id} className="rounded-lg bg-surface-2 p-2 text-[11px] leading-snug text-muted">
          <b className="text-fg">{s.name}</b> was not tested: {s.reason}.
        </p>
      ))}
      {rows.length > 0 && (
        <>
          <Segmented className="w-full" size="sm" value={filter} onChange={setFilter} options={FILTERS} />
          <ul className="divide-y divide-line">
            {list.map((r) => (
              <li key={r.key} className="space-y-0.5 py-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">
                    {r.label} <Badge tone={VERDICT[r.verdict].tone}>{VERDICT[r.verdict].text}</Badge>
                  </span>
                  <span className={`num shrink-0 text-sm font-bold ${pnlClass(r.net)}`}>{formatPnl(r.net)}</span>
                </div>
                <p className="num text-[11px] text-muted">
                  {r.group} · {r.trades} trades · {r.winRate ?? '–'}% win · {callWord} {formatPnl(r.calls.net)} ({r.calls.trades}) · {putWord} {formatPnl(r.puts.net)} ({r.puts.trades}) · halves {formatPnl(r.halves[0])} / {formatPnl(r.halves[1])}
                </p>
              </li>
            ))}
          </ul>
          {shown.length > SHOW && (
            <button type="button" className="btn btn-sm w-full" onClick={() => setAll((a) => !a)}>
              {all ? 'Show fewer' : `Show all ${shown.length}`}
            </button>
          )}
          {!shown.length && <p className="text-xs text-muted">None in this group.</p>}
        </>
      )}
    </Card>
  );
}
