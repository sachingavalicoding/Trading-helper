import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarSearch, Database, FlaskConical, ClipboardCopy, Search, TrendingUp } from 'lucide-react';
import { Picker, Skeleton } from '../components/ui.jsx';
import { DayReportButton } from '../components/DayReportButton.jsx';
import { OptionsStudy } from '../components/options/OptionsStudy.jsx';
import { SharesStudy } from '../components/study/SharesStudy.jsx';
import { FinderStudy } from '../components/study/FinderStudy.jsx';
import { HistoryData } from '../components/study/HistoryData.jsx';

const Review = lazy(() => import('./Review.jsx'));

export const RESEARCH_TABS = [
  { value: 'review', label: 'Day review', icon: CalendarSearch, hint: 'Every call against what happened, and improve a combination' },
  { value: 'options', label: 'Options study', icon: TrendingUp, hint: 'Replay past candles: which option entries pay' },
  { value: 'shares', label: 'Shares study', icon: FlaskConical, hint: 'Replay past candles: which share setups pay' },
  { value: 'finder', label: 'Finder', icon: Search, hint: 'Extra checks that lift a combination, and its best stop and profit' },
  { value: 'data', label: 'Saved data', icon: Database, hint: 'The candles and option prices the other sections read' },
  { value: 'report', label: 'Day report', icon: ClipboardCopy, hint: 'Copy the day report to paste in the chat' },
];

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
      <Picker title="Research section" value={tab} onChange={setTab} options={RESEARCH_TABS} />
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
