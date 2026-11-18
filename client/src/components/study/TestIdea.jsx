import { lazy, Suspense } from 'react';
import { ChevronLeft, FlaskConical, Layers, Search, Shapes, Gauge, TrendingUp } from 'lucide-react';
import { Segmented, Skeleton } from '../ui.jsx';

const Lab = lazy(() => import('../../pages/Lab.jsx'));
const FinderStudy = lazy(() => import('./FinderStudy.jsx').then((m) => ({ default: m.FinderStudy })));
const LadderTester = lazy(() => import('./LadderTester.jsx').then((m) => ({ default: m.LadderTester })));
const MovedTester = lazy(() => import('./MovedTester.jsx').then((m) => ({ default: m.MovedTester })));
const OptionsStudy = lazy(() => import('../options/OptionsStudy.jsx').then((m) => ({ default: m.OptionsStudy })));
const SharesStudy = lazy(() => import('./SharesStudy.jsx').then((m) => ({ default: m.SharesStudy })));

/** Studies: options or shares, every pattern, combination and the score bot replayed on the saved days. */
function Studies({ kind, setKind }) {
  return (
    <div className="space-y-3">
      <Segmented className="w-full" size="sm" value={kind} onChange={setKind} options={[{ value: 'options', label: 'Options' }, { value: 'shares', label: 'Shares' }]} />
      {kind === 'shares' ? <SharesStudy /> : <OptionsStudy />}
    </div>
  );
}

// What can be tested, in the order you use it. `group` splits "what to test" from "make it stronger".
export const TOOLS = [
  { id: 'combo', group: 'test', icon: FlaskConical, label: 'A combination', hint: 'Every entry over 15 days or more: trade by trade, with its chart, profit and loss', view: () => <Lab embedded focus="combos" /> },
  { id: 'pattern', group: 'test', icon: Shapes, label: 'A chart pattern', hint: 'Where it formed, and what a trade at that moment made', view: () => <Lab embedded focus="patterns" /> },
  { id: 'score', group: 'test', icon: Gauge, label: 'Score bot and studies', hint: 'Patterns, combinations and the indicator score together, on the saved days', view: ({ kind, setKind }) => <Studies kind={kind} setKind={setKind} /> },
  { id: 'finder', group: 'stronger', icon: Search, label: 'Best indicator, stop and exit', hint: 'Tries every extra indicator, stop (SL) and profit exit on top of yours, checked on days it never saw', view: () => <FinderStudy /> },
  { id: 'ladder', group: 'stronger', icon: Layers, label: 'Best profit ladder', hint: 'Your auto entries on real option prices, sold with many profit ladders', view: () => <LadderTester /> },
  { id: 'late', group: 'stronger', icon: TrendingUp, label: 'Skip late entries', hint: 'Do entries after the market already ran lose? With and without a limit', view: () => <MovedTester /> },
];

function Tile({ tool, onPick }) {
  const Icon = tool.icon;
  return (
    <button type="button" onClick={() => onPick(tool.id)} className="card-shadow flex flex-col items-start gap-1 rounded-2xl border border-line bg-surface p-3 text-left transition-colors hover:border-accent2">
      <Icon className="h-5 w-5 text-accent2" />
      <span className="text-sm font-semibold leading-tight">{tool.label}</span>
      <span className="text-[11px] leading-snug text-muted">{tool.hint}</span>
    </button>
  );
}

/** Research > Test an idea: pick what to test, then (or from the same list) the tool that makes it stronger. */
export function TestIdea({ tool, onTool, kind, setKind }) {
  const cur = TOOLS.find((t) => t.id === tool);
  if (cur) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onTool('')} aria-label="Back to the list of tests">
            <ChevronLeft className="h-4 w-4" /> All tests
          </button>
          <h2 className="min-w-0 truncate text-sm font-semibold">{cur.label}</h2>
        </div>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>{cur.view({ kind, setKind })}</Suspense>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {[
        ['test', 'What do you want to test?'],
        ['stronger', 'Make it stronger'],
      ].map(([group, title]) => (
        <section key={group} className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
          <div className="grid grid-cols-2 gap-2">
            {TOOLS.filter((t) => t.group === group).map((t) => (
              <Tile key={t.id} tool={t} onPick={onTool} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
