import { useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { pnlClass } from '../lib/format.js';
import { Card, Segmented, Skeleton } from './ui.jsx';

const VIEWS = [
  { value: 'bySetup', label: 'Setup' },
  { value: 'byHour', label: 'Hour' },
  { value: 'bySide', label: 'Side' },
  { value: 'byScore', label: 'Score' },
];

const avg = (r) => (r == null ? '–' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`);

/** How finished scanner ideas ended. Average R is the result per unit of risk, so it counts size of wins and losses, not only how often. */
export function ScannerRecord() {
  const { data, loading } = useApi('/scanner/stats', []);
  const [view, setView] = useState('bySetup');
  if (loading && !data) return <Skeleton className="h-40" />;
  if (!data) return null;
  const o = data.overall;

  return (
    <Card className="space-y-3 p-3">
      <h2 className="text-sm font-semibold">Scanner track record</h2>
      {o.count === 0 ? (
        <p className="text-sm text-muted">No finished ideas yet. Results build up as ideas reach target 1, the stop or expiry.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="num text-lg font-bold">{o.count}</div>
              <div className="text-[11px] text-muted">ideas</div>
            </div>
            <div>
              <div className="num text-lg font-bold">{o.winRate}%</div>
              <div className="text-[11px] text-muted">hit target 1</div>
            </div>
            <div>
              <div className={`num text-lg font-bold ${pnlClass(o.avgR)}`}>{avg(o.avgR)}</div>
              <div className="text-[11px] text-muted">average per idea</div>
            </div>
          </div>
          <Segmented size="sm" options={VIEWS} value={view} onChange={setView} className="w-full" />
          <div className="divide-y divide-line text-sm">
            {data[view].map((r) => (
              <div key={r.key} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{r.label || r.key}</div>
                  <div className="text-[11px] text-muted">
                    {r.count} ideas · {r.wins} target · {r.stops} stopped · {r.expired} expired
                  </div>
                </div>
                <div className="text-right">
                  <div className="num font-semibold">{r.winRate}%</div>
                  <div className={`num text-[11px] ${pnlClass(r.avgR)}`}>{avg(r.avgR)}</div>
                </div>
              </div>
            ))}
          </div>
          {!o.enough && <p className="rounded-lg bg-warn/15 px-3 py-2 text-xs">Only {o.count} finished ideas so far. Under {data.minSample}, these percentages are mostly luck. Do not trade real money on them.</p>}
        </>
      )}
      <p className="text-[11px] leading-snug text-muted">1R is the amount an idea risks. An idea that hits target 1 usually earns 1.5R or more; one that is stopped loses 1R. {data.disclaimer}</p>
    </Card>
  );
}
