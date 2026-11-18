import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Blocks, Layers, Search, Shapes, Gauge, TrendingUp } from 'lucide-react';
import { Segmented, Skeleton } from '../ui.jsx';

const OptionsLab = lazy(() => import('../../pages/Lab.jsx').then((m) => ({ default: m.OptionsLab })));
const SharesLab = lazy(() => import('../lab/SharesLab.jsx').then((m) => ({ default: m.SharesLab })));
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

/** A chart pattern on Nifty (options), or one check on the 50 stocks (shares). Your own combinations are tested on the Combos page. */
function PatternTest() {
  const [seg, setSeg] = useState('options');
  return (
    <div className="space-y-3">
      <Segmented className="w-full" size="sm" value={seg} onChange={setSeg} options={[{ value: 'options', label: 'Options: a pattern' }, { value: 'shares', label: 'Shares: one check' }]} />
      {seg === 'shares' ? <SharesLab checksOnly /> : <OptionsLab focus="patterns" />}
    </div>
  );
}

// What can be tested, in the order you use it. `group` splits "what to test" from "make it stronger".
export const TOOLS = [
  { id: 'combo', group: 'test', icon: Blocks, label: 'A combination', hint: 'Opens Combos: tap a combination for every entry over 15 days or more, its chart, profit and loss', to: '/combos' },
  { id: 'pattern', group: 'test', icon: Shapes, label: 'A pattern or one check', hint: 'Where it formed, and what a trade at that moment made', view: () => <PatternTest /> },
  { id: 'score', group: 'test', icon: Gauge, label: 'Score bot and studies', hint: 'Patterns, combinations and the indicator score together, on the saved days', view: ({ kind, setKind }) => <Studies kind={kind} setKind={setKind} /> },
  { id: 'finder', group: 'stronger', icon: Search, label: 'Best indicator, stop and exit', hint: 'Tries every extra indicator, stop (SL) and profit exit on top of yours, checked on days it never saw', view: () => <FinderStudy /> },
  { id: 'ladder', group: 'stronger', icon: Layers, label: 'Best profit ladder', hint: 'Your auto entries on real option prices, sold with many profit ladders', view: () => <LadderTester /> },
  { id: 'late', group: 'stronger', icon: TrendingUp, label: 'Skip late entries', hint: 'Do entries after the market already ran lose? With and without a limit', view: () => <MovedTester /> },
];

const TILE = 'card-shadow flex flex-col items-start gap-1 rounded-2xl border border-line bg-surface p-3 text-left transition-colors hover:border-accent2';

function Tile({ tool, onPick }) {
  const Icon = tool.icon;
  const body = (
    <>
      <Icon className="h-5 w-5 text-accent2" />
      <span className="flex w-full items-center justify-between gap-1 text-sm font-semibold leading-tight">{tool.label} {tool.to && <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}</span>
      <span className="text-[11px] leading-snug text-muted">{tool.hint}</span>
    </>
  );
  // a combination is tested where it is kept: the Combos page
  if (tool.to) return <Link to={tool.to} className={TILE}>{body}</Link>;
  return (
    <button type="button" onClick={() => onPick(tool.id)} className={TILE}>
      {body}
    </button>
  );
}

/** Research > Test an idea: pick what to test, then (or from the same list) the tool that makes it stronger. */
export function TestIdea({ tool, onTool, kind, setKind }) {
  const cur = TOOLS.find((t) => t.id === tool && t.view);
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
