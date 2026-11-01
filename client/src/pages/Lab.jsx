import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FlaskConical } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { formatPnl as rawPnl, formatPrice, pnlClass } from '../lib/format.js';
import { canAdd, withFound } from '../lib/autoFind.js';
import { LAB_DAYS, LAB_PRICES, addonLine, exitsPath, dayWord, entryStory, exitStory, entryMarkers, equityPath, equityRange, exitWord, fixLine, labPath, togglePick, whenText } from '../lib/lab.js';
import { VERDICT } from '../lib/combos.js';
import { whyText } from '../lib/patternReview.js';
import { LabChart } from '../components/LabChart.jsx';
import { TradeChart } from '../components/TradeChart.jsx';
import { ComboResearch } from '../components/study/ComboResearch.jsx';
import { bestOf } from '../lib/research.js';
import { useTheme } from '../context/ThemeContext.jsx';
import { Badge, Card, EmptyState, Fold, Segmented, Skeleton } from '../components/ui.jsx';

const formatPnl = (v) => rawPnl(Math.round(v));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const dayOfSec = (t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const STORE = 'lab.base';

function Tile({ label, value, sub, tone = '' }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2.5">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`num whitespace-nowrap text-base font-bold ${tone}`}>{value}</div>
      {sub && <div className="num text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

function Summary({ s, title, tone }) {
  const pf = s.profitFactor == null ? '–' : s.profitFactor.toFixed(2);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className={`text-sm font-semibold ${tone}`}>{title}</h3>
        {VERDICT[s.verdict] && <Badge tone={VERDICT[s.verdict].tone}>{VERDICT[s.verdict].text}</Badge>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Net after charges" value={formatPnl(s.net)} tone={pnlClass(s.net)} sub={`${s.trades} entries`} />
        <Tile label="Win rate" value={s.winRate == null ? '–' : `${s.winRate}%`} sub={`${s.wins} won, ${s.trades - s.wins} lost`} />
        <Tile label="Worst dip" value={formatPnl(-s.maxDrawdown)} tone="text-down" sub="from a peak" />
        <Tile label="Average win" value={s.avgWin == null ? '–' : formatPnl(s.avgWin)} tone="text-up" />
        <Tile label="Average loss" value={s.avgLoss == null ? '–' : formatPnl(s.avgLoss)} tone="text-down" />
        <Tile label="Profit factor" value={pf} sub={`longest losing run ${s.longestLosingRun}`} />
      </div>
      <p className="num text-[11px] text-muted">Older half {formatPnl(s.halves[0])} · newer half {formatPnl(s.halves[1])}</p>
    </div>
  );
}

/** Profit and loss as it built up, the starting combination against the one with the picks added. */
function Equity({ base, withAdd }) {
  const range = equityRange(base.equity, withAdd?.equity);
  const w = 320;
  const h = 100;
  const zero = h - 4 - ((0 - range.min) / Math.max(range.max - range.min, 1)) * (h - 8);
  return (
    <div className="space-y-1">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-28 w-full" role="img" aria-label="Profit and loss as it built up">
        <line x1="0" x2={w} y1={zero} y2={zero} stroke="var(--border)" strokeDasharray="3 3" />
        <path d={equityPath(base.equity, { w, h, ...range })} fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinejoin="round" />
        {withAdd && <path d={equityPath(withAdd.equity, { w, h, ...range })} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />}
      </svg>
      <p className="flex flex-wrap gap-x-3 text-[11px] text-muted">
        <span><span className="inline-block h-0.5 w-4 bg-muted align-middle" /> now {formatPnl(base.net)}</span>
        {withAdd && <span><span className="inline-block h-0.5 w-4 bg-accent align-middle" /> with picks {formatPnl(withAdd.net)}</span>}
      </p>
    </div>
  );
}

function DayBars({ days }) {
  const max = Math.max(1, ...days.map((d) => Math.abs(d.net)));
  return (
    <div className="flex h-24 items-center gap-0.5" role="img" aria-label="Net result of each day">
      {days.map((d) => (
        <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-center" title={`${d.day}: ${d.trades} entries, ${formatPnl(d.net)}`}>
          <div className="flex flex-1 items-end"><div className={`w-full rounded-t-sm ${d.net > 0 ? 'bg-up' : 'bg-transparent'}`} style={{ height: `${d.net > 0 ? (d.net / max) * 100 : 0}%` }} /></div>
          <div className="flex flex-1 items-start"><div className={`w-full rounded-b-sm ${d.net < 0 ? 'bg-down' : 'bg-transparent'}`} style={{ height: `${d.net < 0 ? (-d.net / max) * 100 : 0}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function Mini({ rows }) {
  return (
    <ul className="divide-y divide-line text-xs">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center justify-between gap-3 py-1.5">
          <span>{r.label} <span className="num text-[11px] text-muted">{r.sub}</span></span>
          <span className={`num font-semibold ${pnlClass(r.net)}`}>{formatPnl(r.net)}</span>
        </li>
      ))}
    </ul>
  );
}

function Breakdown({ s }) {
  const hours = Object.entries(s.byHour).sort(([a], [b]) => a.localeCompare(b)).map(([h, v]) => ({ label: `${h}:00`, sub: `${v.trades} entries`, net: v.net }));
  const sides = [['CE', 'Calls'], ['PE', 'Puts']].map(([k, label]) => ({ label, sub: `${s.bySide[k].trades} entries, ${s.bySide[k].wins} won`, net: s.bySide[k].net }));
  const exits = Object.entries(s.byExit).map(([r, n]) => ({ label: exitWord(r), sub: `${n}`, net: null }));
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-[11px] font-semibold">Each day</div>
        <DayBars days={s.byDay} />
        <div className="num mt-1 flex justify-between text-[10px] text-muted"><span>{s.byDay[0]?.day}</span><span>{s.byDay.at(-1)?.day}</span></div>
      </div>
      <div><div className="text-[11px] font-semibold">Calls and puts</div><Mini rows={sides} /></div>
      <div><div className="text-[11px] font-semibold">By hour of entry</div><Mini rows={hours} /></div>
      <div>
        <div className="text-[11px] font-semibold">How the entries ended</div>
        <ul className="flex flex-wrap gap-1.5 pt-1">{exits.map((e) => <li key={e.label}><Badge tone="muted">{e.label} {e.sub}</Badge></li>)}</ul>
      </div>
    </div>
  );
}

/** The chart of the whole period with an arrow at every entry; tap an arrow or a row to open the entry. */
function MonthChart({ r, entries, selected, onPick }) {
  const { theme } = useTheme();
  const candles = useMemo(() => r.candles.filter((c) => c.time >= r.rangeFrom), [r]);
  const markers = useMemo(() => entryMarkers(entries, { up: cssVar('--up'), down: cssVar('--down'), muted: cssVar('--muted') }, selected).filter((m) => !m.id.endsWith(':exit')).map((m) => ({ ...m, text: '' })), [entries, selected, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return <LabChart candles={candles} markers={markers} onPick={onPick} />;
}

/** One entry on its own day, with where it went in and out, and what would have skipped it. */
function EntryDetail({ r, e, entries, onPick, onClose }) {
  const bars = useMemo(() => {
    const at = r.candles.findIndex((c) => dayOfSec(c.time) === e.day);
    const end = r.candles.findLastIndex((c) => dayOfSec(c.time) === e.day);
    return at < 0 ? [] : r.candles.slice(Math.max(0, at - 75), end + 1);
  }, [r, e.day]);
  const trade = useMemo(() => ({ side: e.side, entryTime: e.entryTime, exitTime: e.exitTime, entrySpot: e.entrySpot, exitSpot: e.exitSpot, stop: e.stop, net: e.net, label: `${e.side === 'CE' ? 'Buy call' : 'Buy put'} ${whenText(e.entryTime).split(' ').slice(2).join(' ')}`, exitLabel: `${exitWord(e.reason)} ${formatPnl(e.net)}` }), [e]);
  const at = entries.findIndex((x) => x.id === e.id);
  const prev = entries[at - 1];
  const next = entries[at + 1];
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          <button type="button" className="btn btn-sm" disabled={!prev} onClick={() => onPick(prev.id)} aria-label="Earlier entry">‹ Earlier</button>
          <button type="button" className="btn btn-sm" disabled={!next} onClick={() => onPick(next.id)} aria-label="Later entry">Later ›</button>
        </div>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{e.side === 'CE' ? 'Call' : 'Put'} bought {whenText(e.entryTime)}</h3>
          <p className="num text-[11px] text-muted">{e.strike} {e.side}, {e.lots} lot{e.lots > 1 ? 's' : ''}, premium {formatPrice(e.entryPremium)} ({e.priced} price)</p>
        </div>
        <div className="text-right">
          <div className={`num text-base font-bold ${pnlClass(e.net)}`}>{formatPnl(e.net)}</div>
          <div className="text-[11px] text-muted">{exitWord(e.reason)} after {e.minutes} min</div>
        </div>
      </div>
      {bars.length > 0 && <TradeChart bars={bars} trade={trade} />}
      <p className="text-xs leading-snug"><b>Entry.</b> {entryStory(e)}</p>
      <p className="text-xs leading-snug"><b>Exit.</b> {exitStory(e)}</p>
      {e.net <= 0 && (
        <div className="space-y-1 rounded-lg bg-surface-2 p-2">
          <div className="text-xs font-semibold">What would have skipped this loss</div>
          {e.fixes.length ? (
            <ul className="space-y-1 text-[11px] leading-snug">
              {e.fixes.map((f) => (
                <li key={f.key}>
                  <b>+ {f.label}</b> <span className="text-muted">{fixLine(f).replace(`${f.label}: `, '')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-muted">No single check skips this entry on these days. It looked like the winners on every check tried.</p>
          )}
        </div>
      )}
    </Card>
  );
}

/** The best stop, profit ladder, trailing stop and break-even for the start (and the picked checks), tried on the same days. Asked for on its own: it takes a few seconds. */
function BestExits({ path, own, onApplied }) {
  const [state, setState] = useState({ key: null, loading: false, data: null, error: null });
  const mine = state.key === path ? state : { key: path, loading: false, data: null, error: null };
  async function find() {
    setState({ key: path, loading: true, data: null, error: null });
    try {
      const d = await api(path);
      setState({ key: path, loading: false, data: d.research, error: null });
    } catch (e) {
      setState({ key: path, loading: false, data: null, error: e.message || 'Could not run it' });
    }
  }
  const r = mine.data;
  const best = r && !r.skipped ? bestOf(r) : null;
  return (
    <Card className="space-y-2 border-accent/40 p-3">
      <h3 className="text-sm font-semibold text-accent">Best stop and profit ladder</h3>
      <p className="text-[11px] leading-snug text-muted">Tries about 18 stops, 40 ladder shapes, trailing stops and break-even on the same entries (with your picked indicators), one change at a time. A setting counts only if it also paid on the newer days it was not chosen on.</p>
      <button type="button" className="btn btn-primary w-full" disabled={mine.loading} onClick={find}>{mine.loading ? 'Trying the settings…' : r ? 'Run again' : 'Find the best stop and ladder'}</button>
      {mine.error && <p className="text-xs text-down">{mine.error}</p>}
      {r?.skipped && <p className="text-xs text-warn">{r.skipped}</p>}
      {best && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 text-xs">
            <div className="rounded-lg bg-surface-2 p-2.5">
              <div className="text-[10px] text-muted">Your settings now</div>
              <div className="num"><b className={pnlClass(r.base.net)}>{formatPnl(r.base.net)}</b> · {r.base.trades} entries · {r.base.winRate ?? '–'}% win</div>
            </div>
            {[['Best stop', best.stop], ['Best profit setting', best.exit]].map(([label, x]) => (
              <div key={label} className="rounded-lg bg-surface-2 p-2.5">
                <div className="text-[10px] text-muted">{label}</div>
                {x ? (
                  <>
                    <div className="font-semibold">{x.label.replace(/^Stop at /, 'Stop ')}</div>
                    <div className="num text-[11px]"><b className={pnlClass(x.net)}>{formatPnl(x.net)}</b> · {x.trades} entries · {x.winRate ?? '–'}% win · worst {formatPnl(x.worst)}</div>
                    {x.text && <div className="text-[11px] leading-snug text-muted">{x.text}</div>}
                  </>
                ) : (
                  <div className="text-[11px] text-muted">Nothing paid on both the older and the newer days.</div>
                )}
              </div>
            ))}
          </div>
          <ComboResearch r={r} own={own} onApplied={onApplied} />
        </div>
      )}
    </Card>
  );
}

function Entries({ rows, selected, onPick }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="stack-table cols-4 w-full text-xs">
        <thead>
          <tr className="border-b border-line text-left text-[11px] text-muted">
            <th className="px-3 py-2">When</th><th>Side</th><th>Index in → out</th><th>Premium</th><th>Ended</th><th>Result</th><th className="pr-3">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((e) => (
            <tr key={e.id} onClick={() => onPick(e.id)} className={`cursor-pointer ${selected === e.id ? 'bg-accent2-soft' : ''} ${e.status === 'removed' ? 'opacity-60' : ''}`}>
              <td className="px-3 py-2 font-medium">
                {whenText(e.entryTime)} {e.status === 'removed' && <Badge tone="muted">Skipped with picks</Badge>} {e.status === 'added' && <Badge tone="accent">Added by picks</Badge>}
                {e.net <= 0 && e.fixes[0] && e.status !== 'removed' && <span className="block text-[10px] font-normal text-muted">Skipped by: {e.fixes.slice(0, 2).map((f) => f.label).join(', ')}</span>}
              </td>
              <td data-label="Side">{e.side === 'CE' ? 'Call' : 'Put'}</td>
              <td data-label="Index" className="num">{formatPrice(e.entrySpot)} → {formatPrice(e.exitSpot)}</td>
              <td data-label="Premium" className="num">{formatPrice(e.entryPremium)}{e.priced === 'estimated' ? '*' : ''}</td>
              <td data-label="Ended">{exitWord(e.reason)}, {e.minutes}m</td>
              <td data-label="Result">{e.net > 0 ? 'Won' : 'Lost'}</td>
              <td data-label="Net" className={`num pr-3 font-semibold ${pnlClass(e.net)}`}>{formatPnl(e.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-1.5 text-[10px] text-muted">* estimated premium (no real price saved for that day).</p>
    </div>
  );
}

/** The history day by day: how the index moved, and for each entry why it was taken, how it ended, and what would have skipped a loss. */
function DayHistory({ r, onShow }) {
  const byId = useMemo(() => new Map(r.entries.map((e) => [e.id, e])), [r]);
  const days = [...r.dayList].reverse();
  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-snug text-muted">Newest day first. Tap a day to read each entry and exit. "Real" means the option prices come from the premiums saved that evening; "Estimated" means the model's price.</p>
      <ul className="space-y-2">
        {days.map((d) => (
          <li key={d.day}>
            <details className="rounded-xl border border-line">
              <summary className="flex cursor-pointer items-start justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">{dayWord(d.day)} <Badge tone={d.realPrices ? 'up' : 'muted'}>{d.realPrices ? 'Real prices' : 'Estimated'}</Badge></span>
                  <span className="num block text-[11px] text-muted">Index {formatPrice(d.open)} to {formatPrice(d.close)} ({d.changePts >= 0 ? '+' : ''}{Math.round(d.changePts)} pts, range {Math.round(d.rangePts)})</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className={`num block text-sm font-bold ${d.trades ? pnlClass(d.net) : 'text-muted'}`}>{d.trades ? formatPnl(d.net) : 'No entry'}</span>
                  {d.trades > 0 && <span className="num block text-[11px] text-muted">{d.trades} entr{d.trades === 1 ? 'y' : 'ies'}</span>}
                </span>
              </summary>
              <div className="space-y-3 border-t border-line p-3">
                {d.entries.length === 0 && <p className="text-xs text-muted">The combination did not fire on this day, so nothing was bought.</p>}
                {d.entries.map((id) => {
                  const e = byId.get(id);
                  return (
                    <div key={id} className={`space-y-1.5 rounded-lg bg-surface-2 p-2.5 text-xs leading-snug ${e.status === 'removed' ? 'opacity-60' : ''}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{e.side === 'CE' ? 'Call' : 'Put'} at {whenText(e.entryTime).split(' ').slice(2).join(' ')} {e.status === 'removed' && <Badge tone="muted">Skipped with picks</Badge>} {e.status === 'added' && <Badge tone="accent">Added by picks</Badge>}</span>
                        <span className={`num font-bold ${pnlClass(e.net)}`}>{formatPnl(e.net)}</span>
                      </div>
                      <p><b>Entry.</b> {entryStory(e)}</p>
                      <p><b>Exit.</b> {exitStory(e)}</p>
                      {e.net <= 0 && e.fixes.length > 0 && (
                        <p><b>To avoid this loss:</b> {e.fixes.slice(0, 3).map((f) => `${f.label} (${f.winnersLost ? `also skips ${f.winnersLost} winner${f.winnersLost === 1 ? '' : 's'}` : 'skips no winner'})`).join('; ')}.</p>
                      )}
                      {e.net <= 0 && e.fixes.length === 0 && <p className="text-muted">No single indicator tried would have skipped this one.</p>}
                      <button type="button" className="btn btn-sm" onClick={() => onShow(id)}>Show on chart</button>
                    </div>
                  );
                })}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Addons({ rows, add, onToggle }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line">
        {shown.map((a) => {
          const on = add.includes(a.key);
          return (
            <li key={a.key}>
              <button type="button" aria-pressed={on} onClick={() => onToggle(a.key)} className={`flex w-full items-start justify-between gap-3 py-2 text-left text-xs ${on ? 'bg-surface-2' : ''}`}>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">+ {a.label} <Badge tone="muted">{a.group}</Badge> {VERDICT[a.verdict] && <Badge tone={VERDICT[a.verdict].tone}>{VERDICT[a.verdict].text}</Badge>}</span>
                  <span className="num block text-[11px] text-muted">{addonLine(a)}</span>
                  <span className="num block text-[11px] text-muted">leaves {a.trades} entries, {a.winRate ?? '–'}% win, older {formatPnl(a.halves[0])} · newer {formatPnl(a.halves[1])}</span>
                </span>
                <span className={`num shrink-0 text-right font-semibold ${pnlClass(a.gain)}`}>{formatPnl(a.gain)}<span className="block text-[10px] font-normal text-muted">{formatPnl(a.net)} in all</span></span>
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > 10 && <button type="button" className="btn btn-sm w-full" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </div>
  );
}

/** Combination Lab: one combination or pattern over a month of trading, every entry, and which extra check would have skipped each loser. */
export default function Lab({ embedded = false }) {
  const [base, setBase] = useState(() => { try { return localStorage.getItem(STORE) || ''; } catch { return ''; } });
  const [add, setAdd] = useState([]);
  const [days, setDays] = useState('15');
  const [prices, setPrices] = useState('mixed');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const choices = useApi('/lab', []);
  const own = useApi('/options', []);
  const run = useApi(base ? labPath({ base, add, days, prices }) : null, [base, add.join(','), days, prices]);
  const r = run.data?.result;
  const saved = own.data?.settings?.combos;
  const pick = (value) => { setBase(value); setAdd([]); setSelected(null); try { localStorage.setItem(STORE, value); } catch { /* not remembered */ } };
  const backTo = useRef(null);
  // opening an entry jumps to it and remembers where you were, so Close can take you back
  const openEntry = (id) => {
    if (selected == null) backTo.current = window.scrollY;
    setSelected(id);
    setTimeout(() => document.getElementById('lab-entry')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const closeEntry = () => {
    setSelected(null);
    const y = backTo.current;
    backTo.current = null;
    if (y != null) setTimeout(() => window.scrollTo({ top: y, behavior: 'smooth' }), 60);
  };
  const chosen = r?.entries.find((e) => e.id === selected) ?? null;
  const comboBase = base.startsWith('combo:');

  async function save() {
    setBusy(true);
    try {
      const picked = r.addons.filter((a) => add.includes(a.key));
      await api('/options', { method: 'PUT', body: { combos: withFound(saved, { conds: [...r.base.conds, ...add], labels: [r.base.name, ...picked.map((x) => x.label)] }) } });
      own.reload?.();
      toast.success('Saved, switched off. Turn it on under Account > Entries.');
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const list = choices.data?.choices;
  return (
    <div className="space-y-3">
      {!embedded && (
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold"><FlaskConical className="h-5 w-5 text-accent2" /> Combination Lab</h1>
          <p className="text-xs text-muted">Pick a combination or pattern, see how its entries did, and which extra indicator would have skipped each loser.</p>
        </div>
      )}
      <Card className="space-y-2 p-3">
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>Start from</span>
          <select className="field !w-auto max-w-[70%] !px-2 !py-1.5 !text-xs" value={base} onChange={(e) => pick(e.target.value)} aria-label="Combination or pattern">
            <option value="">Choose…</option>
            {list?.combos.length > 0 && <optgroup label="My combinations">{list.combos.map((c) => <option key={c.key} value={c.key}>{c.label}{c.off ? ' (off)' : ''}</option>)}</optgroup>}
            {list && <optgroup label="Patterns">{list.patterns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</optgroup>}
          </select>
        </label>
        <Segmented className="w-full" size="sm" value={days} onChange={(v) => { setDays(v); setSelected(null); }} options={LAB_DAYS} />
        <Fold plain id="lab-prices" title="Option prices" summary={LAB_PRICES.find((p) => p.value === prices).label}>
          <Segmented className="w-full" size="sm" value={prices} onChange={setPrices} options={LAB_PRICES} />
          <p className="text-[11px] text-muted">Real prices come from the premiums saved each evening (Research &gt; Saved data). Days without them use the model's estimate, marked * in the table.</p>
        </Fold>
      </Card>

      {!base && <EmptyState icon={FlaskConical} title="Pick a combination">Choose one of yours (or a pattern) above to see its entries over the last weeks.</EmptyState>}
      {base && run.loading && !r && <Skeleton className="h-64 w-full" />}
      {run.error && <p className="text-xs text-down">{run.error.message || 'Could not run the lab'}</p>}
      {r && (
        <>
          <Card className="space-y-3 p-3">
            <p className="text-[11px] leading-snug text-muted"><b className="text-fg">{r.base.name}</b>: {r.base.text}. {r.period.from} to {r.period.to} ({r.period.days} trading days). {r.pricing.real} entr{r.pricing.real === 1 ? 'y' : 'ies'} priced from real saved premiums, {r.pricing.estimated} estimated.</p>
            <Summary s={r.stats} title={r.withAdd ? 'Now' : 'Result'} tone="" />
            {r.withAdd && <Summary s={r.withAdd} title={`With ${r.withAdd.labels.join(' + ')}`} tone="text-accent" />}
            <Equity base={r.stats} withAdd={r.withAdd} />
            {r.stats.trades < 15 && <p className="text-[11px] text-warn">Only {r.stats.trades} entries: too few to trust. Use a longer period.</p>}
          </Card>

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">Chart with every entry</h3>
            <p className="text-[11px] text-muted">Arrows: up is a call, down a put, green won, red lost, grey skipped with your picks. Tap one to open it.</p>
            <MonthChart r={r} entries={r.entries} selected={selected} onPick={openEntry} />
          </Card>

          {chosen && <div id="lab-entry"><EntryDetail r={r} e={chosen} entries={r.entries} onPick={setSelected} onClose={closeEntry} /></div>}

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">History, day by day</h3>
            <DayHistory r={r} onShow={openEntry} />
          </Card>

          <Card className="space-y-2 border-accent2/40 p-3">
            <h3 className="text-sm font-semibold text-accent2">Add an indicator</h3>
            <p className="text-[11px] leading-snug text-muted">Every other indicator, added to {r.base.name} (all must hold), over the same days. Best first by what it changes in the net. Tap up to three to see the entries it skips in the table and the chart.</p>
            {r.addons.length === 0 ? <p className="text-xs text-muted">No single indicator changes these entries.</p> : <Addons rows={r.addons} add={add} onToggle={(k) => { setAdd((a) => togglePick(a, k)); setSelected(null); }} />}
            {add.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {comboBase && <button type="button" className="btn btn-sm" disabled={busy || !saved || !canAdd(saved)} onClick={save}>{canAdd(saved) ? 'Save as a new combination (off)' : 'My combinations is full (30)'}</button>}
                <button type="button" className="btn btn-sm" onClick={() => setAdd([])}>Clear picks</button>
              </div>
            )}
            <p className="text-[11px] text-muted">With about 100 indicators tried, a few will look good by luck. Prefer one that removes losers on both the older and the newer half, and paper-test it.</p>
          </Card>

          <BestExits path={exitsPath({ base, add, days, prices })} own={comboBase} onApplied={own.reload} />

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">All entries ({r.entries.length})</h3>
            {r.entries.length ? <Entries rows={r.entries} selected={selected} onPick={openEntry} /> : <p className="text-xs text-muted">This gave no entry in these days.</p>}
          </Card>

          {r.stats.trades > 0 && (
            <Fold id="lab-breakdown" title="Breakdown" summary="Each day, calls and puts, hours, how entries ended">
              <Breakdown s={r.withAdd ?? r.stats} />
            </Fold>
          )}
          <p className="text-[11px] leading-snug text-muted">{run.data.note}</p>
        </>
      )}
    </div>
  );
}
