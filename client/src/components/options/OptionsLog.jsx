import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMarket } from '../../context/MarketContext.jsx';
import { useApi } from '../../lib/useApi.js';
import { formatPrice, formatPnl, formatTime, pnlClass } from '../../lib/format.js';
import { EXIT_LABEL } from '../../lib/options.js';
import { DataTable, Stack } from '../DataTable.jsx';
import { Badge, Card, Skeleton } from '../ui.jsx';

const shiftDay = (day, by) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
};

function Detail({ e }) {
  const d = e.detail || {};
  return (
    <Card className="space-y-2 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{e.label}</h3>
        <Badge tone={e.decision === 'PLACED' ? 'up' : 'muted'}>{e.decision === 'PLACED' ? (e.status === 'OPEN' ? 'Open' : 'Closed') : 'Skipped'}</Badge>
      </div>
      {e.reason && <p className="text-muted">Skipped: {e.reason}</p>}
      {e.decision === 'PLACED' && (
        <p className="num text-muted">
          {d.lots} lot · bought ₹{formatPrice(e.fillPrice)} · stop ₹{formatPrice(e.stopLoss)} (−{d.lossPct}%) · risk ₹{formatPrice(d.maxLoss)} · IV {d.iv}%
          <br />
          Nifty was {formatPrice(d.spot)} when bought.
        </p>
      )}
      {e.outcome && (
        <p className="num text-muted">
          {EXIT_LABEL[e.outcome.exitReason]} at ₹{formatPrice(e.outcome.exitPrice)} after {e.outcome.minutesHeld} min · {e.outcome.resultR}R · best {e.outcome.bestR ?? '–'}R / worst {e.outcome.worstR ?? '–'}R · gross {formatPnl(e.outcome.grossPnl)}, charges ₹{formatPrice(e.outcome.charges)}
        </p>
      )}
      {e.checks && (
        <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {e.checks.map((c) => (
            <li key={c.id} className="flex justify-between gap-2 py-0.5">
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
    </Card>
  );
}

/** Every decision the options trader made on a day: placed or skipped, with the reason, the plan and how it ended. */
export function OptionsLog() {
  const { version, status } = useMarket();
  const today = status?.market?.istDate;
  const [picked, setPicked] = useState(null);
  const day = picked || today;
  const { data, loading } = useApi(day ? `/options/log?day=${day}` : null, [version]);
  const [open, setOpen] = useState(null);
  if (!day || (loading && !data)) return <Skeleton className="h-48 w-full" />;
  const sum = data?.summary;
  const entries = data?.entries || [];
  const selected = entries.find((e) => e._id === open);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button type="button" aria-label="Previous day" onClick={() => setPicked(shiftDay(day, -1))} className="btn btn-secondary btn-sm">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="num text-sm font-semibold">{day === today ? `Today · ${day}` : day}</span>
        <button type="button" aria-label="Next day" disabled={day >= today} onClick={() => setPicked(shiftDay(day, 1))} className="btn btn-secondary btn-sm">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      {sum && (
        <Card className="space-y-1 p-3 text-xs">
          <p className="num text-muted">
            {sum.placed} placed · {sum.skipped} skipped · {sum.wins} won · {sum.losses} lost · net <span className={pnlClass(sum.netPnl)}>{formatPnl(sum.netPnl)}</span> (charges ₹{formatPrice(sum.charges)})
            {sum.gaveBack > 0 && ` · ${sum.gaveBack} were in profit first, then lost`}
          </p>
          {sum.byExit.length > 0 && <p className="num text-muted">{sum.byExit.map((g) => `${EXIT_LABEL[g.key] || g.key} ${g.trades} (${formatPnl(g.netPnl)})`).join(' · ')}</p>}
          {sum.skipReasons.length > 0 && <p className="text-muted">Skipped because: {sum.skipReasons.map((r) => `${r.example} ×${r.count}`).join(' · ')}</p>}
        </Card>
      )}
      {entries.length === 0 ? (
        <Card className="p-4 text-sm text-muted">No decisions on this day. The trader writes a row when it takes a trade, or when a strong setup was turned down.</Card>
      ) : (
        <Card className="overflow-hidden">
          <DataTable
            onRowClick={(e) => setOpen(open === e._id ? null : e._id)}
            columns={[
              { key: 't', header: 'Time', render: (e) => formatTime(e.decidedAt).slice(0, 5) },
              { key: 'what', header: 'Decision', render: (e) => <Stack top={<>{e.label} {e.decision === 'SKIPPED' && <Badge>skipped</Badge>}</>} sub={e.decision === 'SKIPPED' ? e.reason : e.outcome ? `${EXIT_LABEL[e.outcome.exitReason]} · ${e.outcome.minutesHeld}m` : `open · ${e.detail?.lots ?? ''} lot`} /> },
              { key: 'score', header: 'Score', align: 'right', render: (e) => e.score ?? '—' },
              { key: 'net', header: 'Net', align: 'right', render: (e) => (e.outcome ? <span className={`font-semibold ${pnlClass(e.outcome.netPnl)}`}>{formatPnl(e.outcome.netPnl)}</span> : '—') },
            ]}
            rows={entries}
          />
        </Card>
      )}
      {selected && <Detail e={selected} />}
    </div>
  );
}
