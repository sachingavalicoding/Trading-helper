import { lazy, Suspense } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Brain, Database, FlaskConical, ClipboardCopy, Layers, Search, TrendingUp } from 'lucide-react';
import { Picker, Skeleton } from '../components/ui.jsx';

// each tab loads only when it is opened, so the Research page itself opens fast
const Lab = lazy(() => import('./Lab.jsx'));
const Learner = lazy(() => import('../components/study/Learner.jsx').then((m) => ({ default: m.Learner })));
const OptionsStudy = lazy(() => import('../components/options/OptionsStudy.jsx').then((m) => ({ default: m.OptionsStudy })));
const SharesStudy = lazy(() => import('../components/study/SharesStudy.jsx').then((m) => ({ default: m.SharesStudy })));
const FinderStudy = lazy(() => import('../components/study/FinderStudy.jsx').then((m) => ({ default: m.FinderStudy })));
const MovedTester = lazy(() => import('../components/study/MovedTester.jsx').then((m) => ({ default: m.MovedTester })));
const LadderTester = lazy(() => import('../components/study/LadderTester.jsx').then((m) => ({ default: m.LadderTester })));
const HistoryData = lazy(() => import('../components/study/HistoryData.jsx').then((m) => ({ default: m.HistoryData })));
const DayReportButton = lazy(() => import('../components/DayReportButton.jsx').then((m) => ({ default: m.DayReportButton })));

// The auto-learner first (it does the rest by itself), then in the order you use them: test one combination, make it better, then tune its exits. The rest is reference.
export const RESEARCH_TABS = [
  { value: 'learner', label: 'Auto-learner', icon: Brain, hint: 'Finds a better combination on the saved days each evening, checked on days it never saw. One switch to use it on paper' },
  { value: 'lab', label: '1. Test a combination', icon: FlaskConical, hint: 'Pick one combination or pattern: every entry over weeks, a chart, a trust check, and the indicator that would skip each loss' },
  { value: 'finder', label: '2. Find a better one', icon: Search, hint: 'Tries every extra indicator on top of yours, checked on days it never saw. Update yours or save a new one' },
  { value: 'ladder', label: '3. Tune the profit ladder', icon: Layers, hint: 'Your auto entries on 30 days of real option prices, sold with many profit ladders' },
  { value: 'moved', label: '4. Skip late entries', icon: TrendingUp, hint: 'Do entries after the market already ran lose? With and without a limit' },
  { value: 'options', label: 'Options study (all at once)', icon: TrendingUp, hint: 'Replay past candles for every pattern and combination together' },
  { value: 'shares', label: 'Shares study', icon: FlaskConical, hint: 'Replay past candles: which share setups pay' },
  { value: 'data', label: 'Saved data', icon: Database, hint: 'The candles and option prices the other sections read' },
  { value: 'report', label: 'Day report', icon: ClipboardCopy, hint: 'Copy the day report to paste in the chat' },
];

/** Everything for trying ideas, in one place: the Combination Lab, the studies, the finder, saved data and the day report. (Day review lives in Account.) */
export default function Research() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = RESEARCH_TABS.some((t) => t.value === asked) ? asked : 'learner';
  const setTab = (value) => {
    const next = new URLSearchParams(params);
    next.set('tab', value);
    setParams(next, { replace: true });
  };
  if (asked === 'review') {
    // the old address of Day review: it now lives in Account
    const rest = new URLSearchParams(params);
    rest.delete('tab');
    return <Navigate to={`/review${rest.toString() ? `?${rest}` : ''}`} replace />;
  }
  return (
    <div className="space-y-3">
      <Picker title="Research section" value={tab} onChange={setTab} options={RESEARCH_TABS} />
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        {tab === 'learner' && <Learner />}
        {tab === 'lab' && <Lab embedded />}
        {tab === 'options' && <OptionsStudy />}
        {tab === 'shares' && <SharesStudy />}
        {tab === 'finder' && <FinderStudy />}
        {tab === 'ladder' && <LadderTester />}
        {tab === 'moved' && <MovedTester />}
        {tab === 'data' && <HistoryData />}
        {tab === 'report' && <DayReportButton />}
      </Suspense>
    </div>
  );
}
