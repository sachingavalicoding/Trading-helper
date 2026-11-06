import { useState } from 'react';
import { Play, Target } from 'lucide-react';
import { useStudy } from '../../lib/useStudy.js';
import { loadIndex } from '../../lib/indexes.js';
import { Card, Segmented } from '../ui.jsx';
import { AutoFound } from './AutoFound.jsx';

/** The sentence over the list: what was asked, how many tries, and why a short window proves little. */
export function winIntro(w) {
  return `${w.tried} combinations tried (single checks, pairs and triples of the ${w.pool?.length ?? 0} best) on the last ${w.days} trading days with real option prices where saved. ${w.matches} won at least ${w.minWin}% of at least ${w.minTrades} trades and made money; the best ${w.found.length} are shown, highest win rate first. Read the trade counts: with so few days and so many tries some of these are luck, so add one switched off and watch it live before trusting it.`;
}

/**
 * "Find 70% win rate combinations": the combinations that won most of their trades over the last 5 or 10 days, with the number of
 * trades each rests on. It runs only this finder, so it takes a minute or two.
 */
export function WinFinder() {
  const [days, setDays] = useState(10);
  const [minWin, setMinWin] = useState(70);
  const [minTrades, setMinTrades] = useState(5);
  const { state, error, running, run } = useStudy('options');
  const w = state?.result?.winFound ?? null;

  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            <h3 className="text-sm font-semibold">Win-rate finder</h3>
            <p className="text-[11px] leading-snug text-muted">Shows the indicator and pattern combinations that won the most trades in the last few days, with how many trades each rests on. No searching by hand.</p>
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-muted">Days to read</div>
          <Segmented className="w-full" size="sm" value={days} onChange={setDays} options={[{ value: 5, label: 'Last 5 days' }, { value: 10, label: 'Last 10 days' }]} />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-muted">Win rate at least</div>
          <Segmented className="w-full" size="sm" value={minWin} onChange={setMinWin} options={[{ value: 60, label: '60%' }, { value: 70, label: '70%' }, { value: 80, label: '80%' }]} />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-muted">Trades at least</div>
          <Segmented className="w-full" size="sm" value={minTrades} onChange={setMinTrades} options={[{ value: 3, label: '3' }, { value: 5, label: '5' }, { value: 8, label: '8' }]} />
        </div>
        <div className="flex justify-end">
          <button type="button" disabled={running} className="btn btn-primary btn-sm" onClick={() => run(days, { index: loadIndex(), winFind: true, winMinWin: minWin, winMinTrades: minTrades, realPrices: true })}>
            <Play className="h-3.5 w-3.5" /> {running ? 'Running…' : 'Find winners'}
          </button>
        </div>
        {running && <p className="text-xs text-muted">{state.status.step}. It takes a minute or two.</p>}
        {state?.status?.state === 'failed' && <p className="text-xs text-down">{state.status.error}</p>}
        {error && <p className="text-xs text-down">{error}</p>}
      </Card>
      {w && <AutoFound af={w} title={`Combinations at ${w.minWin ?? minWin}% or better`} intro={w.skipped ? null : winIntro(w)} empty={`Nothing in these ${w.days} days won ${w.minWin}% of ${w.minTrades} or more trades and made money. Try a lower win rate or fewer trades, or more days.`} />}
    </div>
  );
}
