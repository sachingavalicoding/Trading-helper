import { useMemo, useRef, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { useApi } from '../../lib/useApi.js';
import { formatPnl as rawPnl, formatPrice, pnlClass } from '../../lib/format.js';
import { LAB_DAYS, dayWord, exitWord, fixLine, labPath, shareEntryStory, shareExitStory, togglePick, whenText } from '../../lib/lab.js';
import { orderText, shareSideWord } from '../../lib/combos.js';
import { TradeChart } from '../TradeChart.jsx';
import { AddOnActions } from '../AddOnActions.jsx';
import { InfoButton } from '../CheckInfo.jsx';
import { TrustBadge } from '../TrustBadge.jsx';
import { Badge, Card, EmptyState, Fold, Segmented, Skeleton } from '../ui.jsx';
import { Addons, Breakdown, Equity, Summary } from './LabParts.jsx';
import { LabOrders } from './OrderSettings.jsx';

const formatPnl = (v) => rawPnl(Math.round(v));
const STORE = 'lab.sharesBase';
const SIDES = [['CE', 'Buys'], ['PE', 'Short sales']];
const sideText = (e) => (e.side === 'CE' ? 'Buy' : 'Short');
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const SHOW = 40;

/** One share entry on its day: the stock's chart with the entry, stop and exit, and what would have skipped it. */
function EntryDetail({ e, entries, onPick, onClose }) {
  const bars = useApi(`/lab/bars?symbol=${encodeURIComponent(e.symbol)}&day=${e.day}`, [e.symbol, e.day]);
  const trade = useMemo(() => ({ side: e.side, entryTime: e.entryTime, exitTime: e.exitTime, entrySpot: e.entry, exitSpot: e.exitPrice, stop: e.stopLoss, net: e.net, label: `${sideText(e)} ${whenText(e.entryTime).split(' ').slice(2).join(' ')}`, exitLabel: `${exitWord(e.reason)} ${formatPnl(e.net)}` }), [e]);
  const at = entries.findIndex((x) => x.id === e.id);
  const prev = entries[at - 1];
  const next = entries[at + 1];
  const list = bars.data?.bars ?? [];
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
          <h3 className="text-sm font-semibold">{e.symbol}: {e.side === 'CE' ? 'bought' : 'sold short'} {whenText(e.entryTime)}</h3>
          <p className="num text-[11px] text-muted">{e.qty} shares at {formatPrice(e.entry)}, stop {formatPrice(e.stopLoss)}, {rs(e.amount)} in the trade</p>
        </div>
        <div className="text-right">
          <div className={`num text-base font-bold ${pnlClass(e.net)}`}>{formatPnl(e.net)}</div>
          <div className="text-[11px] text-muted">{exitWord(e.reason)} after {e.minutes} min</div>
        </div>
      </div>
      {bars.loading && !list.length && <Skeleton className="h-48 w-full" />}
      {list.length > 0 && <TradeChart bars={list} trade={trade} />}
      <p className="text-xs leading-snug"><b>Entry.</b> {shareEntryStory(e)}</p>
      <p className="text-xs leading-snug"><b>Exit.</b> {shareExitStory(e)}</p>
      {e.net <= 0 && (
        <div className="space-y-1 rounded-lg bg-surface-2 p-2">
          <div className="text-xs font-semibold">What would have skipped this loss</div>
          {e.fixes.length ? (
            <ul className="space-y-1 text-[11px] leading-snug">
              {e.fixes.map((f) => <li key={f.key}><b>+ {f.label}</b> <span className="text-muted">{fixLine(f).replace(`${f.label}: `, '')}</span></li>)}
            </ul>
          ) : (
            <p className="text-[11px] text-muted">No single check skips this entry on these days.</p>
          )}
        </div>
      )}
    </Card>
  );
}

function Entries({ rows, selected, onPick }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(-SHOW).reverse();
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="stack-table cols-4 w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-muted">
              <th className="px-3 py-2">When</th><th>Stock</th><th>Side</th><th>In → out</th><th>Qty</th><th>Ended</th><th className="pr-3">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((e) => (
              <tr key={e.id} onClick={() => onPick(e.id)} className={`cursor-pointer ${selected === e.id ? 'bg-accent2-soft' : ''} ${e.status === 'removed' ? 'opacity-60' : ''}`}>
                <td className="px-3 py-2 font-medium">
                  {whenText(e.entryTime)} {e.status === 'removed' && <Badge tone="muted">Skipped with picks</Badge>} {e.status === 'added' && <Badge tone="accent">Added by picks</Badge>}
                  {e.net <= 0 && e.fixes[0] && e.status !== 'removed' && <span className="block text-[10px] font-normal text-muted">Skipped by: {e.fixes.slice(0, 2).map((f) => f.label).join(', ')}</span>}
                </td>
                <td data-label="Stock" className="font-semibold">{e.symbol}</td>
                <td data-label="Side">{sideText(e)}</td>
                <td data-label="In → out" className="num">{formatPrice(e.entry)} → {formatPrice(e.exitPrice)}</td>
                <td data-label="Qty" className="num">{e.qty}</td>
                <td data-label="Ended">{exitWord(e.reason)}, {e.minutes}m</td>
                <td data-label="Net" className={`num pr-3 font-semibold ${pnlClass(e.net)}`}>{formatPnl(e.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > SHOW && <button type="button" className="btn btn-sm w-full" onClick={() => setAll((v) => !v)}>{all ? `Show the newest ${SHOW}` : `Show all ${rows.length} (oldest first)`}</button>}
    </div>
  );
}

function DayHistory({ r, onShow }) {
  const byId = useMemo(() => new Map(r.entries.map((e) => [e.id, e])), [r]);
  const days = [...r.dayList].reverse();
  return (
    <ul className="space-y-2">
      {days.map((d) => (
        <li key={d.day}>
          <details className="rounded-xl border border-line">
            <summary className="flex cursor-pointer items-start justify-between gap-3 px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{dayWord(d.day)}</span>
                <span className="num block text-[11px] text-muted">Nifty {d.changePts >= 0 ? '+' : ''}{Math.round(d.changePts)} pts (range {Math.round(d.rangePts)})</span>
              </span>
              <span className="shrink-0 text-right">
                <span className={`num block text-sm font-bold ${d.trades ? pnlClass(d.net) : 'text-muted'}`}>{d.trades ? formatPnl(d.net) : 'No entry'}</span>
                {d.trades > 0 && <span className="num block text-[11px] text-muted">{d.trades} trade{d.trades === 1 ? '' : 's'}</span>}
              </span>
            </summary>
            <div className="space-y-2 border-t border-line p-3">
              {d.entries.length === 0 && <p className="text-xs text-muted">Nothing fired on this day.</p>}
              {d.entries.map((id) => {
                const e = byId.get(id);
                return (
                  <div key={id} className={`space-y-1 rounded-lg bg-surface-2 p-2.5 text-xs leading-snug ${e.status === 'removed' ? 'opacity-60' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{e.symbol} {sideText(e).toLowerCase()} at {whenText(e.entryTime).split(' ').slice(2).join(' ')} {e.status === 'removed' && <Badge tone="muted">Skipped with picks</Badge>} {e.status === 'added' && <Badge tone="accent">Added by picks</Badge>}</span>
                      <span className={`num font-bold ${pnlClass(e.net)}`}>{formatPnl(e.net)}</span>
                    </div>
                    <p>{shareExitStory(e)}</p>
                    {e.net <= 0 && e.fixes.length > 0 && <p><b>To avoid this loss:</b> {e.fixes.slice(0, 3).map((f) => f.label).join('; ')}.</p>}
                    <button type="button" className="btn btn-sm" onClick={() => onShow(id)}>Open</button>
                  </div>
                );
              })}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

function Stocks({ rows }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : [...rows.slice(0, 5), ...(rows.length > 10 ? rows.slice(-5) : rows.slice(5))];
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line text-xs">
        {shown.map((s) => (
          <li key={s.symbol} className="flex items-center justify-between gap-3 py-1.5">
            <span><b>{s.symbol}</b> <span className="num text-[11px] text-muted">{s.trades} trades, {s.wins} won</span></span>
            <span className={`num font-semibold ${pnlClass(s.net)}`}>{formatPnl(s.net)}</span>
          </li>
        ))}
      </ul>
      {rows.length > 10 && <button type="button" className="btn btn-sm w-full" onClick={() => setAll((v) => !v)}>{all ? 'Best and worst 5 only' : `All ${rows.length} stocks`}</button>}
    </div>
  );
}

/** What the order settings of this run were, in one line. */
function usedLine(u) {
  const take = u.target > 0 ? `sell at +${rs(u.target)}` : u.steps?.length ? `profit lock from +${rs(u.steps[0].at)}` : 'no profit lock';
  return `Risk ${rs(u.riskAmount)} a trade, at most ${rs(u.maxAmount)} in one, ${u.stopPct > 0 ? `stop ${u.stopPct}% away` : 'chart stop'}, ${take}, close at ${clock(u.exitMin)}, at most ${u.maxOpen} open together${u.dailyLoss > 0 ? `, stop for the day after −${rs(u.dailyLoss)}` : ''}.`;
}

/** Combination Lab for shares: one share combination (or check) over the Nifty 50 stocks, every entry, the order settings, and which extra check would have skipped each loser. */
export function SharesLab() {
  const [base, setBase] = useState(() => { try { return localStorage.getItem(STORE) || ''; } catch { return ''; } });
  const [add, setAdd] = useState([]);
  const [days, setDays] = useState('15');
  const [edit, setEdit] = useState(null);
  const [selected, setSelected] = useState(null);
  const auto = useApi('/auto', []);
  const run = useApi(base ? labPath({ segment: 'shares', base, add, days, edit }) : '/lab?segment=shares', [base, add.join(','), days, JSON.stringify(edit)]);
  const r = run.data?.result;
  const list = run.data?.choices;
  const saved = auto.data?.settings?.combos;
  const comboBase = base.startsWith('combo:');
  const combo = comboBase ? saved?.find((c) => c.id === base.slice(6)) ?? null : null;
  const check = !comboBase && base.startsWith('check:') ? { key: base.slice(6), label: list?.checks.find((c) => c.key === base)?.label ?? base.slice(6) } : null;
  const account = { risk: auto.data?.rules?.stopLoss, maxAmount: auto.data?.settings?.maxTradeAmount, steps: auto.data?.rules?.steps, exitMin: auto.data?.rules?.exitMin };
  const pick = (value) => { setBase(value); setAdd([]); setEdit(null); setSelected(null); try { localStorage.setItem(STORE, value); } catch { /* not remembered */ } };
  const backTo = useRef(null);
  const openEntry = (id) => {
    if (selected == null) backTo.current = window.scrollY;
    setSelected(id);
    setTimeout(() => document.getElementById('lab-share-entry')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const closeEntry = () => {
    setSelected(null);
    const y = backTo.current;
    backTo.current = null;
    if (y != null) setTimeout(() => window.scrollTo({ top: y, behavior: 'smooth' }), 60);
  };
  const chosen = r?.entries.find((e) => e.id === selected) ?? null;
  const pickedLabels = r ? r.addons.filter((a) => add.includes(a.key)).map((a) => a.label) : [];
  const afterSave = () => { auto.reload?.(); run.reload?.(); setEdit(null); setAdd([]); setSelected(null); };
  const groups = useMemo(() => {
    const g = new Map();
    for (const c of list?.checks ?? []) g.set(c.group, [...(g.get(c.group) || []), c]);
    return [...g];
  }, [list]);

  return (
    <div className="space-y-3">
      <Card className="space-y-2 p-3">
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>Start from</span>
          <select className="field !w-auto max-w-[70%] !px-2 !py-1.5 !text-xs" value={base} onChange={(e) => pick(e.target.value)} aria-label="Share combination or check">
            <option value="">Choose…</option>
            {list?.combos.length > 0 && <optgroup label="My share combinations">{list.combos.map((c) => <option key={c.key} value={c.key}>{c.label}{c.off ? ' (off)' : ''}</option>)}</optgroup>}
            {groups.map(([g, cs]) => <optgroup key={g} label={`One check: ${g}`}>{cs.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</optgroup>)}
          </select>
        </label>
        <Segmented className="w-full" size="sm" value={days} onChange={(v) => { setDays(v); setSelected(null); }} options={LAB_DAYS} />
        {list && !list.combos.length && <p className="text-[11px] text-muted">You have no share combination yet. Build one in Research &gt; Reports &gt; My combinations (Shares), or start from one check.</p>}
      </Card>

      {!base && <EmptyState icon={FlaskConical} title="Pick a share combination">Choose one of yours (or a single check) to see how it would have traded the Nifty 50 stocks.</EmptyState>}
      {base && run.loading && !r && (
        <div className="space-y-2">
          <Skeleton className="h-64 w-full" />
          <p className="text-center text-[11px] text-muted">Reading 50 stocks the first time takes a little while.</p>
        </div>
      )}
      {run.error && <p className="text-xs text-down">{run.error.message || 'Could not run the lab'}</p>}
      {r && (
        <>
          <Card className="space-y-3 p-3">
            <div className="flex items-start gap-1">
              <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted"><b className="text-fg">{r.base.name}</b>: {r.base.text} {r.period.from} to {r.period.to} ({r.period.days} trading days, {r.period.stocks} stocks).{combo?.side ? ` ${shareSideWord(combo)}.` : ''}</p>
              <InfoButton keys={r.base.conds} title={r.base.name} rule={comboBase ? r.base.text : null} />
            </div>
            {r.orders.edited && <p className="rounded-lg border border-accent/50 bg-surface-2 p-2 text-[11px] font-semibold text-accent">Test settings, not saved: {orderText({ order: r.orders.order, exits: r.orders.steps ? { steps: r.orders.steps } : undefined }) || 'Account settings'}{r.orders.side ? `, ${shareSideWord(r.orders)}` : ''}.</p>}
            <Summary s={r.stats} title={r.withAdd ? 'Now' : 'Result'} />
            {r.withAdd && <Summary s={r.withAdd} title={`With ${r.withAdd.labels.join(' + ')}`} tone="text-accent" />}
            <Equity base={r.stats} withAdd={r.withAdd} />
            <TrustBadge trades={r.stats.trades} winRate={r.stats.winRate} net={r.stats.net} long />
            <p className="text-[11px] leading-snug text-muted">{usedLine(r.orders.used)} Charges {formatPnl(-r.stats.charges)}.</p>
            {(r.blocked.busy > 0 || r.blocked.sameStock > 0 || r.blocked.dailyLoss > 0 || r.blocked.size > 0 || r.blocked.charges > 0) && (
              <p className="text-[11px] leading-snug text-muted">
                Not taken, like live: {[r.blocked.busy && `${r.blocked.busy} with your most trades already open`, r.blocked.sameStock && `${r.blocked.sameStock} already in that stock`, r.blocked.dailyLoss && `${r.blocked.dailyLoss} after the daily loss limit`, r.blocked.size && `${r.blocked.size} where not one share fit the risk`, r.blocked.charges && `${r.blocked.charges} where charges were too big for the stop`].filter(Boolean).join(', ')}.
              </p>
            )}
            {r.stats.trades < 15 && <p className="text-[11px] text-warn">Only {r.stats.trades} trades: too few to trust. Use a longer period.</p>}
          </Card>

          {(combo || check) && <LabOrders segment="shares" combo={combo} check={check} saved={saved} account={account} testing={Boolean(edit)} onTest={(d) => { setEdit(d); setSelected(null); }} onSaved={afterSave} />}

          {chosen && <div id="lab-share-entry"><EntryDetail e={chosen} entries={r.entries} onPick={setSelected} onClose={closeEntry} /></div>}

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">All trades ({r.entries.length})</h3>
            <p className="text-[11px] text-muted">Newest first. Tap a row for the stock's chart and the story of the trade.</p>
            {r.entries.length ? <Entries rows={r.entries} selected={selected} onPick={openEntry} /> : <p className="text-xs text-muted">No trade in these days.</p>}
          </Card>

          <Card className="space-y-2 border-accent2/40 p-3">
            <h3 className="text-sm font-semibold text-accent2">Add an indicator</h3>
            <p className="text-[11px] leading-snug text-muted">Every other check, added to {r.base.name} (all must hold), on the same days and stocks. Best first by what it changes in the net. Tap up to three.</p>
            {r.addons.length === 0 ? <p className="text-xs text-muted">No single check changes these trades.</p> : <Addons rows={r.addons} add={add} onToggle={(k) => { setAdd((a) => togglePick(a, k)); setSelected(null); }} />}
            {add.length > 0 && comboBase && <AddOnActions saved={saved} comboId={base.slice(6)} add={add} labels={pickedLabels} endpoint="/auto" onSaved={afterSave} onClear={() => setAdd([])} />}
            <p className="text-[11px] text-muted">With about 100 checks tried, a few will look good by luck. Prefer one that helps in both the older and the newer half.</p>
          </Card>

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">History, day by day</h3>
            <DayHistory r={r} onShow={openEntry} />
          </Card>

          {r.stats.trades > 0 && (
            <Fold id="lab-share-breakdown" title="Breakdown" summary="Stocks, each day, buys and shorts, hours, how trades ended">
              <div className="space-y-3">
                <div><div className="text-[11px] font-semibold">Best and worst stocks</div><Stocks rows={(r.withAdd ?? r.stats).byStock} /></div>
                <Breakdown s={r.withAdd ?? r.stats} sideNames={SIDES} sideTitle="Buys and short sales" />
              </div>
            </Fold>
          )}
          <p className="text-[11px] leading-snug text-muted">{run.data.note}</p>
        </>
      )}
    </div>
  );
}
