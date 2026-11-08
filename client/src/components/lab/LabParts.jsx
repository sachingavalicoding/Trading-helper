import { useState } from 'react';
import { formatPnl as rawPnl, pnlClass } from '../../lib/format.js';
import { addonLine, equityPath, equityRange, exitWord } from '../../lib/lab.js';
import { VERDICT } from '../../lib/combos.js';
import { InfoButton } from '../CheckInfo.jsx';
import { Badge } from '../ui.jsx';

// The parts of the Combination Lab page shared by its options and shares views.

const formatPnl = (v) => rawPnl(Math.round(v));

export function Tile({ label, value, sub, tone = '' }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2.5">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`num whitespace-nowrap text-base font-bold ${tone}`}>{value}</div>
      {sub && <div className="num text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

export function Summary({ s, title, tone }) {
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
export function Equity({ base, withAdd }) {
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

export function DayBars({ days }) {
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

export function Mini({ rows }) {
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

export function Breakdown({ s, sideNames = [['CE', 'Calls'], ['PE', 'Puts']], sideTitle = 'Calls and puts' }) {
  const hours = Object.entries(s.byHour).sort(([a], [b]) => a.localeCompare(b)).map(([h, v]) => ({ label: `${h}:00`, sub: `${v.trades} entries`, net: v.net }));
  const sides = sideNames.map(([k, label]) => ({ label, sub: `${s.bySide[k].trades} entries, ${s.bySide[k].wins} won`, net: s.bySide[k].net }));
  const exits = Object.entries(s.byExit).map(([r, n]) => ({ label: exitWord(r), sub: `${n}`, net: null }));
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-[11px] font-semibold">Each day</div>
        <DayBars days={s.byDay} />
        <div className="num mt-1 flex justify-between text-[10px] text-muted"><span>{s.byDay[0]?.day}</span><span>{s.byDay.at(-1)?.day}</span></div>
      </div>
      <div><div className="text-[11px] font-semibold">{sideTitle}</div><Mini rows={sides} /></div>
      <div><div className="text-[11px] font-semibold">By hour of entry</div><Mini rows={hours} /></div>
      <div>
        <div className="text-[11px] font-semibold">How the entries ended</div>
        <ul className="flex flex-wrap gap-1.5 pt-1">{exits.map((e) => <li key={e.label}><Badge tone="muted">{e.label} {e.sub}</Badge></li>)}</ul>
      </div>
    </div>
  );
}

export function Addons({ rows, add, onToggle }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line">
        {shown.map((a) => {
          const on = add.includes(a.key);
          return (
            <li key={a.key} className={`flex items-start gap-1 ${on ? 'bg-surface-2' : ''}`}>
              <button type="button" aria-pressed={on} onClick={() => onToggle(a.key)} className="flex min-w-0 flex-1 items-start justify-between gap-3 py-2 text-left text-xs">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">+ {a.label} <Badge tone="muted">{a.group}</Badge> {VERDICT[a.verdict] && <Badge tone={VERDICT[a.verdict].tone}>{VERDICT[a.verdict].text}</Badge>}</span>
                  <span className="num block text-[11px] text-muted">{addonLine(a)}</span>
                  <span className="num block text-[11px] text-muted">leaves {a.trades} entries, {a.winRate ?? '–'}% win, older {formatPnl(a.halves[0])} · newer {formatPnl(a.halves[1])}</span>
                </span>
                <span className={`num shrink-0 text-right font-semibold ${pnlClass(a.gain)}`}>{formatPnl(a.gain)}<span className="block text-[10px] font-normal text-muted">{formatPnl(a.net)} in all</span></span>
              </button>
              <InfoButton keys={a.key} title={a.label} className="mt-1.5" />
            </li>
          );
        })}
      </ul>
      {rows.length > 10 && <button type="button" className="btn btn-sm w-full" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </div>
  );
}

