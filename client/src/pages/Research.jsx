import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Segmented, Skeleton } from '../components/ui.jsx';
import { DayReportButton } from '../components/DayReportButton.jsx';
import { OptionsStudy } from '../components/options/OptionsStudy.jsx';
import { SharesStudy } from '../components/study/SharesStudy.jsx';
import { FinderStudy } from '../components/study/FinderStudy.jsx';
import { HistoryData } from '../components/study/HistoryData.jsx';

const Review = lazy(() => import('./Review.jsx'));

export const RESEARCH_TABS = [
  { value: 'review', label: 'Day review' },
  { value: 'options', label: 'Options' },
  { value: 'shares', label: 'Shares' },
  { value: 'finder', label: 'Finder' },
  { value: 'data', label: 'Data' },
  { value: 'report', label: 'Report' },
];

const HINTS = {
  review: 'Pick a day and see every call against what happened. Improve a combination here too.',
  options: 'Replay past candles to see which option entries pay.',
  shares: 'Replay past candles to see which share setups pay.',
  finder: 'Find the extra checks that make a combination win more, and its best stop and profit.',
  data: 'The saved candles and option prices the other tabs read.',
  report: 'Copy the day report to paste in the chat.',
};

/** Everything for looking back and improving, in one place: day review, studies, the finder, saved data and the day report. */
export default function Research() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = RESEARCH_TABS.some((t) => t.value === asked) ? asked : 'review';
  const setTab = (value) => {
    const next = new URLSearchParams(params);
    next.set('tab', value);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-bold">
          Re<span className="text-accent2">search</span>
        </h1>
        <p className="text-[11px] leading-snug text-muted">{HINTS[tab]}</p>
      </div>
      <div className="-mx-4 overflow-x-auto px-4">
        <Segmented className="min-w-max" size="sm" value={tab} onChange={setTab} options={RESEARCH_TABS} />
      </div>
      {tab === 'review' && (
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Review embedded />
        </Suspense>
      )}
      {tab === 'options' && <OptionsStudy />}
      {tab === 'shares' && <SharesStudy />}
      {tab === 'finder' && <FinderStudy />}
      {tab === 'data' && <HistoryData />}
      {tab === 'report' && <DayReportButton />}
    </div>
  );
}
