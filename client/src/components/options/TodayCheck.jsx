import { useState } from 'react';
import { CircleAlert, CircleCheck, OctagonX } from 'lucide-react';
import { useMarket } from '../../context/MarketContext.jsx';
import { useApi } from '../../lib/useApi.js';
import { Card, Skeleton } from '../ui.jsx';

const LOOK = {
  go: { icon: CircleCheck, box: 'border-up/40', text: 'text-up' },
  care: { icon: CircleAlert, box: 'border-warn/50', text: 'text-warn' },
  stop: { icon: OctagonX, box: 'border-down/50', text: 'text-down' },
};

/** "Is it a good time to trade?": the index today (trending or choppy) and your own state, as one green, amber or red line. */
export function TodayCheck({ index }) {
  const { version } = useMarket();
  const { data, loading } = useApi(`/options/today-check?index=${index}`, [index, version]);
  const [open, setOpen] = useState(false);
  if (loading && !data) return <Skeleton className="h-14 w-full" />;
  if (!data?.verdict) return null;
  const look = LOOK[data.verdict];
  const Icon = look.icon;
  const top = data.reasons.filter((r) => r.level === data.verdict)[0] ?? data.reasons[0];
  return (
    <Card className={`space-y-2 border p-3 ${look.box}`}>
      <button type="button" className="flex w-full items-start gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${look.text}`} />
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-semibold ${look.text}`}>{data.headline}</span>
          {top && <span className="block text-[11px] leading-snug text-muted">{top.text}</span>}
        </span>
        <span className="shrink-0 text-[11px] font-semibold text-accent">{open ? 'Less' : 'Why'}</span>
      </button>
      {open && (
        <ul className="space-y-1 border-t border-line pt-2 text-xs leading-snug">
          {data.reasons.map((r) => {
            const RIcon = LOOK[r.level].icon;
            return (
              <li key={r.text} className="flex items-start gap-1.5">
                <RIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${LOOK[r.level].text}`} />
                <span>{r.text}</span>
              </li>
            );
          })}
          <li className="pt-1 text-[11px] text-muted">The market check reads the index's 5-minute bars today: how straight its path was (trend) or how much it went back and forth (chop), and its range against the last 10 days. It is a guide; the bot's own limits are in Settings.</li>
        </ul>
      )}
    </Card>
  );
}
