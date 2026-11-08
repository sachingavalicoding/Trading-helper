import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FlaskConical } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { formatPnl as rawPnl, formatPrice, pnlClass } from '../lib/format.js';
import { canAdd, withFound } from '../lib/autoFind.js';
import { LAB_DAYS, LAB_PRICES, dayWord, entryStory, exitStory, entryMarkers, exitWord, fixLine, labPath, togglePick, whenText } from '../lib/lab.js';
import { whyText } from '../lib/patternReview.js';
import { LabChart } from '../components/LabChart.jsx';
import { TradeChart } from '../components/TradeChart.jsx';
import { AddOnActions } from '../components/AddOnActions.jsx';
import { InfoButton } from '../components/CheckInfo.jsx';
import { TrustBadge } from '../components/TrustBadge.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { Badge, Card, EmptyState, Fold, Segmented, Skeleton } from '../components/ui.jsx';
import { Addons, Breakdown, Equity, Summary } from '../components/lab/LabParts.jsx';
import { LabOrders } from '../components/lab/OrderSettings.jsx';
import { SharesLab } from '../components/lab/SharesLab.jsx';

const formatPnl = (v) => rawPnl(Math.round(v));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const dayOfSec = (t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const STORE = 'lab.base';

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

const SEGMENT = 'lab.segment';

/** Combination Lab: options or shares. */
export default function Lab({ embedded = false }) {
  const [segment, setSegment] = useState(() => { try { return localStorage.getItem(SEGMENT) || 'options'; } catch { return 'options'; } });
  const choose = (v) => { setSegment(v); try { localStorage.setItem(SEGMENT, v); } catch { /* not remembered */ } };
  return (
    <div className="space-y-3">
      {!embedded && (
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold"><FlaskConical className="h-5 w-5 text-accent2" /> Combination Lab</h1>
          <p className="text-xs text-muted">Pick a combination, see how its entries did, change its order settings, and find which extra indicator would have skipped each loser.</p>
        </div>
      )}
      <Segmented className="w-full" value={segment} onChange={choose} options={[{ value: 'options', label: 'Options' }, { value: 'shares', label: 'Shares' }]} />
      {segment === 'shares' ? <SharesLab /> : <OptionsLab />}
    </div>
  );
}

/** Combination Lab for options: one combination or pattern over a month of trading, every entry, and which extra check would have skipped each loser. */
function OptionsLab() {
  const [base, setBase] = useState(() => { try { return localStorage.getItem(STORE) || ''; } catch { return ''; } });
  const [add, setAdd] = useState([]);
  const [days, setDays] = useState('15');
  const [prices, setPrices] = useState('mixed');
  // the no-stop test: typed numbers are only used once Run is tapped, so each keystroke does not re-run the Lab
  const [noStopOn, setNoStopOn] = useState(false);
  const [lockAt, setLockAt] = useState('5000');
  const [lockKeep, setLockKeep] = useState('4000');
  const [noStop, setNoStop] = useState(null);
  const noStopBad = noStopOn && Number(lockAt) > 0 && !(Number(lockKeep) >= 0 && Number(lockKeep) < Number(lockAt));
  const applyNoStop = () => { setNoStop(noStopOn ? { at: Number(lockAt) || 0, keep: Number(lockKeep) || 0 } : null); setSelected(null); };
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);
  const choices = useApi('/lab', []);
  const own = useApi('/options', []);
  const run = useApi(base ? labPath({ base, add, days, prices, noStop, edit }) : null, [base, add.join(','), days, prices, noStop?.at, noStop?.keep, Boolean(noStop), JSON.stringify(edit)]);
  const r = run.data?.result;
  const saved = own.data?.settings?.combos;
  const pick = (value) => { setBase(value); setAdd([]); setEdit(null); setSelected(null); try { localStorage.setItem(STORE, value); } catch { /* not remembered */ } };
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

  const pickedLabels = r ? r.addons.filter((a) => add.includes(a.key)).map((a) => a.label) : [];
  const afterSave = () => { own.reload?.(); choices.reload?.(); setAdd([]); setEdit(null); setSelected(null); };

  /** A pattern with add-ons, saved as a new combination: the pattern as a check, and the add-ons, all must hold. */
  async function saveFromPattern() {
    setBusy(true);
    try {
      await api('/options', { method: 'PUT', body: { combos: withFound(saved, { conds: [`p_${base.slice(8)}`, ...add], labels: [r.base.name, ...pickedLabels] }) } });
      afterSave();
      toast.success('Saved, switched off. Turn it on under Account > Entries.');
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const list = choices.data?.choices;
  const combo = comboBase ? saved?.find((c) => c.id === base.slice(6)) ?? null : null;
  return (
    <div className="space-y-3">
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
        <Fold plain id="lab-nostop" title="No stop loss (risky test)" summary={noStop ? `On · lock ₹${noStop.keep} at +₹${noStop.at}` : 'Off'}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs">Trade with no stop loss</span>
            <button type="button" role="switch" aria-checked={noStopOn} aria-label="No stop loss test" onClick={() => setNoStopOn((v) => !v)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${noStopOn ? 'bg-down' : 'bg-surface-3'}`}>
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${noStopOn ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          {noStopOn && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-muted">
                  When profit reaches ₹
                  <input className="field num mt-1 !py-2" inputMode="numeric" value={lockAt} onChange={(e) => setLockAt(e.target.value)} />
                </label>
                <label className="text-[11px] text-muted">
                  Lock in ₹
                  <input className="field num mt-1 !py-2" inputMode="numeric" value={lockKeep} onChange={(e) => setLockKeep(e.target.value)} />
                </label>
              </div>
              <p className="text-[11px] leading-snug text-down">Risky. No stop, no trailing stop, no break-even: a trade is only sold by this lock, by the emergency floor once it has lost half the premium paid, or at the closing time. Leave the lock at 0 for no lock at all.</p>
            </>
          )}
          {noStopBad && <p className="text-[11px] text-down">The profit you lock in must be less than the profit that starts the lock.</p>}
          <button type="button" className="btn btn-sm w-full" disabled={noStopBad} onClick={applyNoStop}>{noStopOn ? 'Run with no stop loss' : noStop ? 'Back to my normal stop' : 'Run'}</button>
        </Fold>
      </Card>

      {!base && <EmptyState icon={FlaskConical} title="Pick a combination">Choose one of yours (or a pattern) above to see its entries over the last weeks.</EmptyState>}
      {base && run.loading && !r && <Skeleton className="h-64 w-full" />}
      {run.error && <p className="text-xs text-down">{run.error.message || 'Could not run the lab'}</p>}
      {r && (
        <>
          <Card className="space-y-3 p-3">
            <div className="flex items-start gap-1">
              <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted"><b className="text-fg">{r.base.name}</b>: {r.base.text}. {r.period.from} to {r.period.to} ({r.period.days} trading days). {r.pricing.real} entr{r.pricing.real === 1 ? 'y' : 'ies'} priced from real saved premiums, {r.pricing.estimated} estimated.</p>
              <InfoButton keys={comboBase ? r.base.conds : [`p_${base.slice(8)}`]} title={r.base.name} rule={comboBase ? r.base.text : null} />
            </div>
            {r.noStop && (
              <div className="space-y-1 rounded-lg border border-down bg-down-soft p-2.5 text-[11px] leading-snug">
                <p className="font-bold text-down">No-stop test (risky): no stop loss, {r.noStop.at > 0 ? `lock ₹${r.noStop.keep} once the profit reaches ₹${r.noStop.at}` : 'no profit lock'}.</p>
                <p>
                  {r.noStop.floorHits} entr{r.noStop.floorHits === 1 ? 'y' : 'ies'} fell to the emergency floor (half the premium lost). Worst single entry <b className="num text-down">{r.noStop.worstTrade == null ? '–' : formatPnl(r.noStop.worstTrade)}</b>.
                  {r.normal && <> The same entries with your normal stop: <b className={`num ${pnlClass(r.normal.net)}`}>{formatPnl(r.normal.net)}</b> ({r.normal.winRate ?? '–'}% won, worst dip {formatPnl(-r.normal.maxDrawdown)}).</>}
                </p>
                <p className="text-muted">A good no-stop result usually comes from a few strong trend days. On a day that turns against you, one trade can lose far more than your loss limit.</p>
              </div>
            )}
            <Summary s={r.stats} title={r.noStop ? (r.withAdd ? 'Now, no stop' : 'Result with no stop loss') : r.withAdd ? 'Now' : 'Result'} tone={r.noStop ? 'text-down' : ''} />
            {r.withAdd && <Summary s={r.withAdd} title={`With ${r.withAdd.labels.join(' + ')}`} tone="text-accent" />}
            <Equity base={r.stats} withAdd={r.withAdd} />
            <TrustBadge trades={r.stats.trades} winRate={r.stats.winRate} net={r.stats.net} long />
            <p className="text-[11px] text-muted">The Lab now replays your live rules (one call and one put at a time, pauses after a loss, your trades a day, and the anti-chase, already-moved and with-the-day checks), so its history is what live would really have done.</p>
            {r.stats.trades < 15 && <p className="text-[11px] text-warn">Only {r.stats.trades} entries: too few to trust. Use a longer period.</p>}
          </Card>

          {r.orders?.edited && <p className="rounded-lg border border-accent/50 bg-surface-2 p-2 text-[11px] font-semibold text-accent">The result above uses test order settings, not the saved ones.</p>}
          {combo && <LabOrders segment="options" combo={combo} saved={saved} testing={Boolean(edit)} onTest={(d) => { setEdit(d); setSelected(null); }} onSaved={afterSave} />}

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
            {add.length > 0 && comboBase && <AddOnActions saved={saved} comboId={base.slice(6)} add={add} labels={pickedLabels} onSaved={afterSave} onClear={() => setAdd([])} />}
            {add.length > 0 && !comboBase && (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="btn btn-sm" disabled={busy || !saved || !canAdd(saved)} onClick={saveFromPattern}>{canAdd(saved) ? 'Save as new combination' : 'My combinations is full (30)'}</button>
                <button type="button" className="btn btn-sm" onClick={() => setAdd([])}>Clear picks</button>
              </div>
            )}
            {add.length > 0 && <p className="text-[11px] leading-snug text-muted">{comboBase ? 'Update changes this combination in place (it asks first). Save as new keeps it and adds a copy with the picks, switched off.' : 'A pattern is not a saved combination, so it can only be saved as a new one (the pattern plus your picks, switched off).'} Tap the i beside any indicator to read how it works.</p>}
            <p className="text-[11px] text-muted">With about 100 indicators tried, a few will look good by luck. Prefer one that removes losers on both the older and the newer half, and paper-test it.</p>
          </Card>

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
