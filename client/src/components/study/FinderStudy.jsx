import { useState } from 'react';
import { ClipboardCopy, Play, Search, Trophy } from 'lucide-react';
import { toast } from 'sonner';
import { copyText } from '../../lib/copyText.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { INDEXES, indexOf, loadIndex, saveIndex } from '../../lib/indexes.js';
import { bestOf } from '../../lib/research.js';
import { sharesText, studyText } from '../../lib/study.js';
import { skipsText, winnerOf } from '../../lib/pairs.js';
import { useApi } from '../../lib/useApi.js';
import { useStudy } from '../../lib/useStudy.js';
import { Card, Segmented, Skeleton } from '../ui.jsx';
import { Switch } from '../options/OptionsAutoCard.jsx';
import { RealPricesSwitch } from './RealPricesSwitch.jsx';
import { AutoFound } from './AutoFound.jsx';
import { PairFinder, StartFromSelect } from './PairFinder.jsx';

const OPTION_DAYS = [
  { value: 10, label: '10d' },
  { value: 20, label: '20d' },
  { value: 30, label: '30d' },
  { value: 62, label: '3mo' },
];
const SHARE_DAYS = [
  { value: 10, label: '10d' },
  { value: 15, label: '15d' },
];
const WHAT = [
  { value: 'add', label: 'Improve a combination' },
  { value: 'new', label: 'Find new ones' },
  { value: 'both', label: 'Both' },
];
const today = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10); // today in IST

/** The best result of the run, with the stop and profit setting that went with it. */
function Winner({ pf }) {
  const w = winnerOf(pf);
  if (!w) return null;
  const { anchor: a, f } = w;
  const { stop, exit } = bestOf(f.research);
  return (
    <Card className="space-y-1.5 border-up/40 p-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-up">
        <Trophy className="h-4 w-4" /> Best found
      </h3>
      <p className="text-xs font-semibold">
        {a.label} + {[].concat(f.added).join(' + ')}
      </p>
      <p className="num text-[11px] text-muted">
        {f.trades} trades · <b className="text-fg">{f.winRate ?? '–'}% win</b> (alone {a.winRate ?? '–'}%) · <b className={pnlClass(f.net)}>{formatPnl(f.net)}</b> (alone {formatPnl(a.net)}) · newer days {formatPnl(f.test.net)}
      </p>
      {skipsText(f) && <p className="num text-[11px] text-muted">It {skipsText(f)}.</p>}
      {(stop || exit) && (
        <p className="num text-[11px] text-muted">
          {stop && <>Stop: <b className="text-fg">{stop.label.replace(/^Stop /, '')}</b> ({formatPnl(stop.net)}). </>}
          {exit && <>Profit: <b className="text-fg">{exit.label}</b> ({formatPnl(exit.net)}).</>}
        </p>
      )}
      <p className="text-[11px] leading-snug text-muted">Open its row below to add it with its best stop. Add keeps it switched off until you turn it on.</p>
    </Card>
  );
}

/**
 * The Finder tab: finds the extra checks that make a combination win more (and skip its bad entries), or new combinations, over the days or
 * dates you choose, then the best stop and profit setting for each. It runs only the finder, so it takes a few minutes.
 */
export function FinderStudy() {
  const [kind, setKind] = useState('options');
  const [index, setIndex] = useState(loadIndex);
  const [what, setWhat] = useState('add');
  const [chosen, setFirst] = useState(null); // null: all my switched-on combinations when I have any, else the best three
  const mine = useApi(kind === 'shares' ? '/auto' : '/options', []);
  const first = chosen ?? (mine.data?.settings?.combos?.some((c) => c.on) ? 'combo:*' : '');
  const [range, setRange] = useState('days');
  const [days, setDays] = useState(30);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(today);
  const [depth, setDepth] = useState(3);
  const [show, setShow] = useState(10);
  const [goal, setGoal] = useState('profit');
  const [research, setResearch] = useState(true);
  const [parts, setParts] = useState(true);
  const [realPrices, setRealPrices] = useState(false);
  const { state, error, running, run } = useStudy(kind);
  const options = kind === 'options';
  const dates = options && range === 'dates';
  const datesBad = dates && (!from || !to || from > to);
  const r = state?.result?.finderOnly ? state.result : null;

  function start() {
    run(dates ? undefined : days, {
      index,
      from: dates ? from : undefined,
      to: dates ? to : undefined,
      pairFind: what !== 'new',
      pairFirst: what !== 'new' ? first || undefined : undefined,
      comboFind: what !== 'add',
      pairDepth: depth,
      pairShow: show,
      pairGoal: goal,
      pairResearch: options ? research : undefined,
      pairParts: what !== 'new' ? parts : undefined,
      realPrices: options ? realPrices : undefined,
    });
  }

  async function copy() {
    const ok = await copyText(options ? studyText(r) : sharesText(r));
    toast[ok ? 'success' : 'info'](ok ? 'Finder result copied. Paste it into the chat.' : 'Could not copy by itself.');
  }

  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <Search className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            <h3 className="text-sm font-semibold">Combination finder</h3>
            <p className="text-[11px] leading-snug text-muted">Find the extra checks that make a combination win more and skip its bad entries.</p>
            <details className="mt-1 text-[11px] leading-snug text-muted">
              <summary className="cursor-pointer font-semibold text-accent">How it works</summary>
              <p className="mt-1">
                Pick a combination (or the best single indicators) and it tries every other check, then the best two and three together. Each is learned on the older two thirds of the days and checked on the newer third it never saw, then the best stop and profit setting is found for it. Only this runs, so it takes a few minutes. Past candles only: no live setting changes.
              </p>
            </details>
          </div>
        </div>
        <Segmented className="w-full" size="sm" value={kind} onChange={setKind} options={[{ value: 'options', label: 'Options' }, { value: 'shares', label: 'Shares' }]} />
        {options && <Segmented className="w-full" size="sm" value={index} onChange={(k) => { setIndex(k); saveIndex(k); }} options={INDEXES.map((i) => ({ value: i.key, label: i.short }))} />}
        <Segmented className="w-full" size="sm" value={what} onChange={setWhat} options={WHAT} />
        {what !== 'new' && <StartFromSelect kind={kind} value={first} onChange={setFirst} />}
        {what !== 'new' && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] leading-snug text-muted">
              <b className="text-fg">Try its parts first.</b> For a combination like Breakout + RSI + Bullish bar it searches Breakout + anything, RSI + anything, Bullish bar + anything, each pair + anything, then the whole combination + anything. Slower.
            </p>
            <Switch on={parts} label="Try the parts of a combination first" onClick={() => setParts((v) => !v)} />
          </div>
        )}
        <div className="space-y-1">
          <div className="text-[11px] text-muted">Extra checks to add to each starting point</div>
          <Segmented className="w-full" size="sm" value={depth} onChange={setDepth} options={[{ value: 1, label: '1' }, { value: 2, label: 'Up to 2' }, { value: 3, label: 'Up to 3' }]} />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-muted">Results to keep per starting point</div>
          <Segmented className="w-full" size="sm" value={show} onChange={setShow} options={[{ value: 5, label: '5' }, { value: 10, label: '10' }, { value: 20, label: '20' }]} />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-muted">Best means</div>
          <Segmented className="w-full" size="sm" value={goal} onChange={setGoal} options={[{ value: 'profit', label: 'Most profit' }, { value: 'winrate', label: 'Highest win rate' }]} />
        </div>
        {options && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] leading-snug text-muted">
              <b className="text-fg">Find the best stop and profit setting</b> for each result: about 18 stop distances, every ladder start and room behind (₹1,500 to ₹6,000 start, ₹250 to ₹1,500 behind), trails and break-even, and how far its winners went against it. Slower.
            </p>
            <Switch on={research} label="Research the stop and profit" onClick={() => setResearch((v) => !v)} />
          </div>
        )}
        {options && <RealPricesSwitch on={realPrices} setOn={setRealPrices} />}
        <div className="space-y-1">
          <div className="text-[11px] text-muted">Days to read</div>
          {options && <Segmented className="w-full" size="sm" value={range} onChange={setRange} options={[{ value: 'days', label: 'Last days' }, { value: 'dates', label: 'Between dates' }]} />}
          {dates ? (
            <div className="grid grid-cols-2 gap-2 text-xs text-muted">
              <label className="space-y-0.5">
                <span>From</span>
                <input type="date" className="field !px-2 !py-1.5 !text-sm" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="First day" />
              </label>
              <label className="space-y-0.5">
                <span>To</span>
                <input type="date" className="field !px-2 !py-1.5 !text-sm" value={to} min={from || undefined} max={today()} onChange={(e) => setTo(e.target.value)} aria-label="Last day" />
              </label>
            </div>
          ) : (
            <Segmented className="w-full" size="sm" value={options ? days : Math.min(days, 15)} onChange={setDays} options={options ? OPTION_DAYS : SHARE_DAYS} />
          )}
          <p className="text-[11px] leading-snug text-muted">Needs 10 trading days or more, at most 65 for options. Longer than 30 days reads the saved candles (Research, Data), so download them first.{!options && ' Shares can read the last 15 days, and have no stop research.'}</p>
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={start} disabled={running || datesBad} className="btn btn-primary btn-sm shrink-0">
            <Play className="h-3.5 w-3.5" /> {running ? 'Running…' : 'Run finder'}
          </button>
        </div>
        {datesBad && <p className="text-xs text-down">Pick a first and a last day, the first not after the last.</p>}
        {running && <p className="text-xs text-muted">{state.status.step}. The finder takes a few minutes.</p>}
        {state?.status?.state === 'failed' && <p className="text-xs text-down">{state.status.error}</p>}
        {error && <p className="text-xs text-down">{error}</p>}
      </Card>

      {!state && !error && <Skeleton className="h-40 w-full" />}
      {state && !r && !running && state.status.state !== 'failed' && <Card className="p-4 text-center text-sm text-muted">No finder result yet. Choose what to find and tap Run finder.</Card>}

      {r && (
        <>
          {r.simulated && <Card className="border-warn p-3 text-xs text-warn">This was made on the sample feed, whose history is random, so the numbers mean nothing. Log in to Upstox and run it again.</Card>}
          <Card className="flex items-center justify-between gap-2 p-3 text-xs">
            <p className="text-muted">
              {r.params?.index === 'SENSEX' ? 'Sensex · ' : ''}
              {r.period.from} to {r.period.to} · {r.period.days} trading days
              {r.pairs?.tried ? ` · ${r.pairs.tried} tried` : ''}
              {r.pricing?.mode === 'real' ? ` · real prices: ${r.pricing.priced} priced, ${r.pricing.skipped} skipped` : ''}
            </p>
            <button type="button" onClick={copy} className="btn btn-sm shrink-0">
              <ClipboardCopy className="h-3.5 w-3.5" /> Copy
            </button>
          </Card>
          <Winner pf={r.pairs} />
          <PairFinder pf={r.pairs} endpoint={options ? '/options' : '/auto'} callWord={options ? 'Calls' : 'Buys'} putWord={options ? 'Puts' : 'Sells'} />
          <AutoFound af={r.comboFound} title="New combinations found" endpoint={options ? '/options' : '/auto'} />
          <p className="text-center text-[11px] leading-snug text-muted">With this many tries some results are luck. Add one switched off, watch it in Review, and turn it on after about two weeks or 20 trades.</p>
        </>
      )}
    </div>
  );
}
