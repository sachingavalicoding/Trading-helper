import { useState } from 'react';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { formatPnl, formatINR, pnlClass } from '../lib/format.js';
import { OptionsSignal } from '../components/options/OptionsSignal.jsx';
import { OptionsAutoCard } from '../components/options/OptionsAutoCard.jsx';
import { OptionsPositions } from '../components/options/OptionsPositions.jsx';
import { OptionsHistory } from '../components/options/OptionsHistory.jsx';
import { OptionsLog } from '../components/options/OptionsLog.jsx';
import { Card, Segmented, Skeleton } from '../components/ui.jsx';

const TABS = [
  { value: 'signal', label: 'Signal' },
  { value: 'positions', label: 'Positions' },
  { value: 'history', label: 'History' },
  { value: 'log', label: 'Log' },
];

/** Nifty 50 index options, paper only. Kept apart from shares: its own positions, orders, history and log. */
export default function Options() {
  const { version } = useMarket();
  const { data, reload } = useApi('/options', [version]);
  const [tab, setTab] = useState('signal');
  const today = data?.today;
  return (
    <div className="space-y-3">
      <Card className="grid grid-cols-3 divide-x divide-line p-3 text-center">
        <div>
          <div className="text-[11px] text-muted">Options today</div>
          <div className={`num text-lg font-bold ${pnlClass(today?.pnl)}`}>{today ? formatPnl(today.pnl) : <Skeleton className="mx-auto h-6 w-20" />}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted">Open / trades</div>
          <div className="num text-lg font-bold">{today ? `${today.open} / ${today.trades}` : '—'}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted">Premium in use</div>
          <div className="num text-lg font-bold">{today ? formatINR(today.spent) : '—'}</div>
        </div>
      </Card>
      <Segmented className="w-full" value={tab} onChange={setTab} options={TABS} />
      {tab === 'signal' && (
        <div className="space-y-3">
          {data && <OptionsAutoCard data={data} reload={reload} />}
          <OptionsSignal minScore={data?.settings.minScore ?? 70} onBought={() => setTab('positions')} />
        </div>
      )}
      {tab === 'positions' && <OptionsPositions />}
      {tab === 'history' && <OptionsHistory />}
      {tab === 'log' && <OptionsLog />}
      <p className="text-center text-[11px] text-muted">{data?.disclaimer}</p>
    </div>
  );
}
