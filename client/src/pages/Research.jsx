import { lazy, Suspense, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { GraduationCap, Database, FlaskConical } from 'lucide-react';
import { Picker, Segmented, Skeleton } from '../components/ui.jsx';
import { TestIdea } from '../components/study/TestIdea.jsx';

// each part loads only when it is opened, so the Research page itself opens fast
const LearnLab = lazy(() => import('../components/lab/LearnLab.jsx').then((m) => ({ default: m.LearnLab })));
const Learner = lazy(() => import('../components/study/Learner.jsx').then((m) => ({ default: m.Learner })));
const HistoryData = lazy(() => import('../components/study/HistoryData.jsx').then((m) => ({ default: m.HistoryData })));
const DayReportButton = lazy(() => import('../components/DayReportButton.jsx').then((m) => ({ default: m.DayReportButton })));

// Three places instead of ten. The test tools themselves are in components/study/TestIdea.jsx.
export const RESEARCH_TABS = [
  { value: 'test', label: 'Test an idea', icon: FlaskConical, hint: 'Pick a combination, pattern or the score bot: every trade over the last days, then find a better indicator, stop and profit ladder' },
  { value: 'learn', label: 'Learn', icon: GraduationCap, hint: 'Find better settings, checked on hidden days, and the auto-learner with its on/off switch' },
  { value: 'data', label: 'Saved data and day report', icon: Database, hint: 'The candles and option prices the tests read, and the day report to copy' },
];

// Old addresses (?tab=lab, finder ...) still open the right place.
const OLD = {
  finder: { tab: 'test', tool: 'finder' },
  ladder: { tab: 'test', tool: 'ladder' },
  moved: { tab: 'test', tool: 'late' },
  options: { tab: 'test', tool: 'score', kind: 'options' },
  shares: { tab: 'test', tool: 'score', kind: 'shares' },
  learner: { tab: 'learn', part: 'auto' },
  report: { tab: 'data' },
};

/** Everything for trying ideas, in one place. (Day review lives in Trades, your combinations in Combos.) */
export default function Research() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const old = OLD[asked];
  const tab = RESEARCH_TABS.some((t) => t.value === asked) ? asked : old?.tab ?? 'test';
  const tool = params.get('tool') ?? old?.tool ?? '';
  const part = params.get('part') ?? old?.part ?? 'settings';
  const [kind, setKind] = useState(old?.kind ?? 'options');
  const set = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ tab, tool, part, ...patch })) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  // the Combination Lab, and testing one combination, now live on the Combos page
  if (asked === 'lab' || (tab === 'test' && tool === 'combo')) return <Navigate to="/combos" replace />;
  if (asked === 'review') {
    // the old address of Day review: it now lives in Trades
    const rest = new URLSearchParams(params);
    rest.delete('tab');
    return <Navigate to={`/review${rest.toString() ? `?${rest}` : ''}`} replace />;
  }
  return (
    <div className="space-y-3">
      <Picker title="Research" value={tab} onChange={(value) => set({ tab: value, tool: '' })} options={RESEARCH_TABS} />
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        {tab === 'test' && <TestIdea tool={tool} onTool={(id) => set({ tool: id })} kind={kind} setKind={setKind} />}
        {tab === 'learn' && (
          <div className="space-y-3">
            <Segmented className="w-full" size="sm" value={part} onChange={(v) => set({ part: v })} options={[{ value: 'settings', label: 'Better settings' }, { value: 'auto', label: 'Auto-learner' }]} />
            {part === 'auto' ? <Learner /> : <LearnLab />}
          </div>
        )}
        {tab === 'data' && (
          <div className="space-y-3">
            <HistoryData />
            <DayReportButton />
          </div>
        )}
      </Suspense>
    </div>
  );
}
