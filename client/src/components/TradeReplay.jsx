import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Flag, LogIn, LogOut, ShieldCheck, TrendingDown, TrendingUp, XCircle } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { formatPnl, formatPrice, formatINR, pnlClass } from '../lib/format.js';
import { checkpoints, chartScales, clockOf, minuteList, rupees } from '../lib/replay.js';
import { Badge, Card, Segmented, Sheet, Skeleton } from './ui.jsx';

const STEP = 7; // pixels per minute
const PRICE_H = 190;
const PNL_H = 86;

const TONE = { up: 'text-up', down: 'text-down', warn: 'text-warn', muted: 'text-muted' };
const EVENT_ICON = { entry: LogIn, exit: LogOut, now: Circle, peak: TrendingUp, trough: TrendingDown, green: TrendingUp, red: TrendingDown, stop: ShieldCheck, breakEven: ShieldCheck, trail: ShieldCheck, spotHit: Flag };
const EVENT_TONE = { entry: 'text-accent', exit: 'text-fg', peak: 'text-up', green: 'text-up', trough: 'text-down', red: 'text-down', stop: 'text-accent', breakEven: 'text-accent', trail: 'text-accent', spotHit: 'text-warn' };

/** Candles of the minutes around the trade, the stop as it moved, and one P&L bar per minute held. Drag sideways, tap a minute. */
function ReplayChart({ candles, minutes, entry, exit, long, stopKey, entryLevel, picked, onPick }) {
  const box = useRef(null);
  const held = useMemo(() => new Map(minutes.map((m) => [m.time, m])), [minutes]);
  const stops = minutes.map((m) => m[stopKey]).filter((v) => v != null);
  const s = useMemo(() => chartScales(candles, { extra: [entryLevel, ...stops], height: PRICE_H }), [candles, entryLevel, stops.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxPnl = Math.max(1, ...minutes.map((m) => Math.abs(m.pnl)));
  const width = Math.max(candles.length * STEP + 8, 300);
  const xOf = (t) => {
    const i = candles.findIndex((c) => c.time >= t - (t % 60));
    return (i < 0 ? candles.length - 1 : i) * STEP + STEP / 2;
  };
  const ex = xOf(exit.time);
  const en = xOf(entry.time);
  useEffect(() => {
    if (box.current) box.current.scrollLeft = Math.max(0, en - 60);
  }, [en]);
  const mid = PRICE_H + PNL_H / 2;
  // the stop as a stepped line over the held minutes
  let path = '';
  minutes.forEach((m, k) => {
    const v = m[stopKey];
    if (v == null) return;
    const x = xOf(m.time);
    path += `${path && minutes[k - 1]?.[stopKey] != null ? 'L' : 'M'}${x - STEP / 2},${s.y(v)} L${x + STEP / 2},${s.y(v)} `;
  });
  return (
    <div className="flex rounded-xl border border-line bg-surface-2/40">
      <div className="num relative w-11 shrink-0 text-[9px] text-muted" style={{ height: PRICE_H + PNL_H }} aria-hidden="true">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const v = s.max - f * (s.max - s.min);
          return (
            <span key={f} className="absolute right-1 -translate-y-1/2" style={{ top: s.y(v) }}>
              {v >= 1000 ? Math.round(v) : v.toFixed(1)}
            </span>
          );
        })}
        <span className="absolute right-1 -translate-y-1/2 text-up" style={{ top: PRICE_H + 6 }}>{rupees(maxPnl)}</span>
        <span className="absolute right-1 -translate-y-1/2" style={{ top: mid }}>0</span>
        <span className="absolute right-1 -translate-y-1/2 text-down" style={{ top: PRICE_H + PNL_H - 6 }}>{rupees(-maxPnl)}</span>
      </div>
      <div ref={box} className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain" style={{ touchAction: 'pan-x pan-y' }}>
        <svg width={width} height={PRICE_H + PNL_H} role="img" aria-label={`Price and profit each minute from ${clockOf(entry.time)} to ${clockOf(exit.time)}`}>
          <rect x={Math.min(en, ex) - STEP / 2} y="0" width={Math.abs(ex - en) + STEP} height={PRICE_H + PNL_H} fill="var(--accent)" opacity="0.06" />
          <line x1="0" x2={width} y1={PRICE_H} y2={PRICE_H} stroke="var(--border)" />
          <line x1="0" x2={width} y1={mid} y2={mid} stroke="var(--muted)" strokeWidth="0.6" strokeDasharray="2 3" />
          {entryLevel != null && <line x1="0" x2={width} y1={s.y(entryLevel)} y2={s.y(entryLevel)} stroke="var(--accent)" strokeDasharray="4 3" strokeWidth="1" />}
          {path && <path d={path} fill="none" stroke="var(--down)" strokeWidth="1.4" />}
          {candles.map((c, i) => {
            const cx = i * STEP + STEP / 2;
            const col = c.close >= c.open ? 'var(--up)' : 'var(--down)';
            const top = s.y(Math.max(c.open, c.close));
            const bot = s.y(Math.min(c.open, c.close));
            const m = held.get(c.time);
            const bh = m ? Math.max(1, (Math.abs(m.pnl) / maxPnl) * (PNL_H / 2 - 4)) : 0;
            const sel = picked === c.time;
            return (
              <g key={c.time} onClick={() => onPick(sel ? null : c.time)} opacity={m || !minutes.length ? 1 : 0.45}>
                <rect x={i * STEP} y="0" width={STEP} height={PRICE_H + PNL_H} fill={sel ? 'var(--accent)' : 'transparent'} opacity={sel ? 0.15 : 1} />
                <line x1={cx} x2={cx} y1={s.y(c.high)} y2={s.y(c.low)} stroke={col} strokeWidth="1" />
                <rect x={cx - 2.2} y={top} width="4.4" height={Math.max(bot - top, 1)} fill={col} />
                {m && <rect x={cx - 2.4} y={m.pnl >= 0 ? mid - bh : mid} width="4.8" height={bh} fill={m.pnl >= 0 ? 'var(--up)' : 'var(--down)'} rx="1" />}
                {i % 10 === 0 && (
                  <text x={cx} y={PRICE_H - 4} fontSize="8.5" textAnchor="middle" fill="var(--muted)">
                    {clockOf(c.time)}
                  </text>
                )}
              </g>
            );
          })}
          <path d={long ? `M${en},${s.y(entryLevel ?? s.min) + 12} l-5,9 h10 z` : `M${en},${s.y(entryLevel ?? s.max) - 12} l-5,-9 h10 z`} fill="var(--accent)" />
          <circle cx={ex} cy={s.y(exit.level ?? s.min)} r="4.5" fill="var(--text)" stroke="var(--bg, #000)" strokeWidth="1.5" />
        </svg>
      </div>
    </div>
  );
}

function Lessons({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="space-y-1.5 rounded-xl bg-surface-2/60 p-3 text-[13px] leading-snug">
      {items.map((l) => (
        <li key={l.text} className="flex gap-2">
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${l.tone === 'down' ? 'bg-down' : l.tone === 'up' ? 'bg-up' : l.tone === 'warn' ? 'bg-warn' : 'bg-muted'}`} />
          <span className={l.tone === 'muted' ? 'text-muted' : ''}>{l.text}</span>
        </li>
      ))}
    </ul>
  );
}

function MinuteTable({ data, picked, onPick }) {
  const [keyOnly, setKeyOnly] = useState(data.minutes.length > 40);
  const rows = useMemo(() => minuteList(data.minutes, data.events, { keyOnly }), [data, keyOnly]);
  const option = data.segment === 'OPT';
  const before = data.events.filter((e) => e.time < (data.minutes[0]?.time ?? 0));
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h3 className="text-sm font-semibold">Minute by minute</h3>
        <Segmented size="sm" value={keyOnly ? 'key' : 'all'} onChange={(v) => setKeyOnly(v === 'key')} options={[{ value: 'all', label: `All ${data.minutes.length}` }, { value: 'key', label: 'Key minutes' }]} />
      </div>
      {before.map((e) => (
        <EventLine key={`${e.kind}${e.time}`} e={e} />
      ))}
      <div className="max-h-[55vh] overflow-y-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 z-10 bg-surface-2 text-[10px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-2 py-1.5 text-left">Time</th>
              <th className="px-1 py-1.5 text-right">{option ? 'Premium' : 'Price'}</th>
              <th className="px-1 py-1.5 text-right">P&amp;L</th>
              <th className="px-2 py-1.5 text-right">Stop</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <MinuteRow key={m.time} m={m} picked={picked === m.time} onPick={onPick} option={option} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function EventLine({ e }) {
  const Icon = EVENT_ICON[e.kind] || Circle;
  return (
    <div className={`flex items-start gap-1.5 px-3 py-1 text-[12px] ${EVENT_TONE[e.kind] || 'text-muted'}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{e.text}</span>
    </div>
  );
}

function MinuteRow({ m, picked, onPick, option }) {
  return (
    <>
      <tr onClick={() => onPick(picked ? null : m.time)} className={`cursor-pointer border-t border-line/60 ${picked ? 'bg-accent-soft' : m.isBest ? 'bg-up/10' : m.isWorst ? 'bg-down/10' : ''}`}>
        <td className="num px-2 py-1.5">
          {clockOf(m.time)} <span className="text-[10px] text-muted">m{m.min}</span>
        </td>
        <td className="num px-1 py-1.5 text-right">
          {formatPrice(m.close)}
          {option && m.spot != null && <div className="text-[10px] text-muted">idx {Math.round(m.spot)}</div>}
        </td>
        <td className="num px-1 py-1.5 text-right">
          <span className={`font-semibold ${pnlClass(m.pnl)}`}>{rupees(m.pnl)}</span>
          {m.change != null && m.change !== 0 && <div className={`text-[10px] ${pnlClass(m.change)}`}>{rupees(m.change)}</div>}
        </td>
        <td className={`num px-2 py-1.5 text-right ${m.stopMoved ? 'font-semibold text-accent' : 'text-muted'}`}>
          {m.stop != null ? formatPrice(m.stop) : '—'}
          {m.spotStop != null && <div className="text-[10px] text-muted">idx {Math.round(m.spotStop)}</div>}
        </td>
      </tr>
      {m.events.length > 0 && (
        <tr>
          <td colSpan={4} className="pb-1">
            {m.events.map((e) => (
              <EventLine key={`${e.kind}${e.time}`} e={e} />
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function WhyTaken({ why, side }) {
  if (!why) return null;
  const kind = why.source?.kind;
  return (
    <Card className="space-y-2.5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Why it was taken</h3>
        <Badge tone={why.manual ? 'muted' : 'accent'}>{why.manual ? 'You placed it' : kind === 'combo' ? 'Your combination' : kind === 'pattern' ? 'Chart pattern' : 'Auto trader'}</Badge>
      </div>
      {why.source?.name && (
        <div className="text-[15px] font-semibold">
          {why.source.name} <span className="text-xs font-normal text-muted">({side === 'CE' || side === 'BUY' ? 'up move' : 'down move'})</span>
        </div>
      )}
      {why.text && <p className="text-xs leading-snug text-muted">{why.text}</p>}
      {why.note && (
        <p className="flex gap-1.5 rounded-lg bg-warn/15 px-2.5 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
          {why.note}
        </p>
      )}
      {why.conditions?.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {why.bar?.forming
              ? `Its checks when it bought (${clockOf(why.bar.time)}-${clockOf(why.bar.upTo)}, bar still forming, bought ${why.bar.clock === 'second' ? 'on the second' : 'on the minute'})`
              : `Its checks at the entry bar${why.bar ? ` (${clockOf(why.bar.time)}-${clockOf(why.bar.time + 300)})` : ''}`}
            {why.need && why.need < why.conditions.length ? ` · needs ${why.need} of ${why.conditions.length}` : ''}
          </div>
          <ul className="space-y-1">
            {why.conditions.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-[13px]">
                {c.held == null ? <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : c.held ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-up" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-down" />}
                <span>
                  <span className="font-medium">{c.label}</span>
                  {c.text && <span className="block text-[11px] leading-snug text-muted">{c.text}</span>}
                </span>
              </li>
            ))}
          </ul>
          {why.mirrored && <p className="mt-1 text-[11px] leading-snug text-muted">This is a put, so each check is read on the chart turned upside down: above means below, up means down, a high means a low.</p>}
          {why.atClose && (
            <p className="mt-1 text-[11px] leading-snug text-muted">
              At the bar&apos;s close ({clockOf(why.atClose.time)}): {why.atClose.held} of {why.atClose.of} still held
              {why.atClose.failed?.length ? ` (no longer: ${why.atClose.failed.join(', ')})` : ''}.
            </p>
          )}
        </div>
      )}
      {why.study && (
        <p className={`rounded-lg px-2.5 py-2 text-xs ${why.study.matched ? 'bg-up/10' : 'bg-warn/15'}`}>
          <b>Live vs study: </b>
          {why.study.text}
          {!why.study.matched && why.study.times?.length > 0 && <> Study times that day: {why.study.times.map((t) => clockOf(t)).join(', ')}.</>}
        </p>
      )}
      {why.readings?.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Chart readings at entry</div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
            {why.readings.map((r) => (
              <div key={r.label} className="min-w-0">
                <dt className="text-[10px] text-muted">{r.label}</dt>
                <dd className="num font-medium leading-snug">
                  {typeof r.value === 'number' ? formatPrice(r.value) : r.value}
                  {r.note && <span className="font-normal text-muted"> · {r.note}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {why.checks?.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Score {why.score ?? ''}: what added up</div>
          <ul className="space-y-0.5 text-[12px]">
            {why.checks.map((c) => (
              <li key={c.label} className="flex justify-between gap-2">
                <span className="min-w-0 text-muted">
                  <b className="text-fg">{c.label}:</b> {c.text}
                </span>
                <span className={`num shrink-0 ${c.points >= c.max ? 'text-up' : c.points > 0 ? 'text-warn' : 'text-muted'}`}>
                  {c.points}/{c.max}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {why.stopNote && <p className="text-[11px] text-muted">Stop: {why.stopNote}</p>}
    </Card>
  );
}

/** Share auto trades: each entry rule tried on this trade, and the score parts that agreed but went with worse results. */
function SkipRules({ s }) {
  if (!s) return null;
  return (
    <Card className="space-y-2 p-3">
      <h3 className="text-sm font-semibold">{s.lost ? 'Why it lost: what could have skipped it' : 'What could have skipped it'}</h3>
      <p className="text-xs leading-snug">{s.text}</p>
      <ul className="space-y-1 text-[12px]">
        {s.rules.map((r) => (
          <li key={r.key} className="flex items-start justify-between gap-2">
            <span className="min-w-0">
              <b className={r.skip ? 'text-down' : 'text-fg'}>{r.skip === true ? '✗ ' : r.skip === false ? '✓ ' : '? '}{r.label}</b>
              <span className="text-muted"> · {r.value}</span>
            </span>
            <span className={`shrink-0 text-[11px] ${r.on ? 'text-up' : 'text-muted'}`}>{r.on ? 'on' : r.rule}</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-snug text-muted">✗ = this rule would have skipped the trade, ✓ = it passed, ? = no reading saved. Values are the ones your Shares study liked.</p>
      {s.late?.length > 0 && (
        <p className="rounded-lg bg-warn/15 px-2.5 py-2 text-xs leading-snug">
          <b>Late-entry signs:</b> {s.late.map((c) => c.label).join(', ')} agreed here. In your 10-day study, ideas where these agreed did worse: the move was often already done.
        </p>
      )}
    </Card>
  );
}

function PlanVsResult({ d }) {
  const r = d.result;
  const ladder = d.exits.lockSteps?.length ? d.exits.lockSteps.map((s) => `+${rupees(s.at).slice(1)} keeps ${rupees(s.keep).slice(1)}`).join(', ') : d.exits.lockTrigger ? `from +${rupees(d.exits.lockTrigger).slice(1)} keeps ${rupees(d.exits.lockAmount).slice(1)}` : 'none';
  const rows = [
    ['Entry', `${formatPrice(d.entry.price)} at ${clockOf(d.entry.time)}`],
    ['First stop', d.entry.stop != null ? formatPrice(d.entry.stop) : 'none'],
    ...(d.entry.stopSpot != null ? [['Chart stop (index)', formatPrice(d.entry.stopSpot)]] : []),
    ['Planned risk', r.plannedRisk != null ? formatINR(r.plannedRisk) : '—'],
    ['Profit lock', ladder],
    ...(d.exits.breakEven ? [['Break-even', `after ${d.exits.breakEven} index points`]] : []),
    ...(d.exits.indexTrail ? [['Trail', `${d.exits.indexTrail.points} points, from +${d.exits.indexTrail.start}`]] : []),
    ['Exit', `${d.exit.price != null ? formatPrice(d.exit.price) : '—'} at ${clockOf(d.exit.time)} · ${d.exit.label}`],
    ['Gross / charges', `${formatPnl(r.gross)} / ${formatINR(r.charges)}`],
  ];
  return (
    <Card className="p-3">
      <h3 className="mb-1.5 text-sm font-semibold">Plan against what happened</h3>
      <dl className="divide-y divide-line/60 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 py-1.5">
            <dt className="text-muted">{k}</dt>
            <dd className="num text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** One trade (shares or options), played back one minute at a time, with why it was taken and how it ended. */
export function TradeReplaySheet({ positionId, title, onClose }) {
  const { data, error, loading } = useApi(positionId ? `/replay/${positionId}` : null, [positionId]);
  const [picked, setPicked] = useState(null);
  const [view, setView] = useState('trade');
  const d = data;
  const option = d?.segment === 'OPT';
  const pickedRow = d && picked != null ? d.minutes.find((m) => m.time === picked) : null;
  const long = d ? (option ? true : d.direction === 'LONG') : true;
  const steps = d ? checkpoints(d.minutes) : [];
  return (
    <Sheet title={d ? d.label : title || 'Trade'} subtitle={d ? `${d.day} · ${d.source === 'AUTO' ? 'auto' : 'by hand'} · held ${d.result.minutes} min · ${d.exit.label}` : 'Loading the minutes…'} onClose={onClose}>
      {loading && !d && (
        <div className="space-y-3 pt-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}
      {error && <p className="pt-3 text-sm text-down">{error.message}</p>}
      {d && (
        <div className="space-y-3 pt-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-[11px] text-muted">Net after charges</div>
              <div className={`num text-3xl font-bold ${pnlClass(d.result.net)}`}>{formatPnl(d.result.net)}</div>
            </div>
            <div className="num text-right text-xs text-muted">
              {d.summary && (
                <>
                  <div>
                    best <span className="text-up">{rupees(d.summary.peak)}</span>
                    {d.summary.peakMin ? ` (m${d.summary.peakMin})` : ''}
                  </div>
                  <div>
                    worst <span className="text-down">{rupees(d.summary.trough)}</span>
                    {d.summary.troughMin ? ` (m${d.summary.troughMin})` : ''}
                  </div>
                </>
              )}
              <div>
                {option ? `${d.lots ?? ''} lot · ` : ''}qty {d.qty}
              </div>
            </div>
          </div>
          {steps.length > 1 && (
            <div className="num flex gap-1.5 overflow-x-auto pb-1 text-[11px]">
              {steps.map((s, i) => (
                <span key={s.label} className="flex shrink-0 items-center gap-1.5">
                  {i > 0 && <span className="text-muted">→</span>}
                  <span className="rounded-full bg-surface-2 px-2 py-0.5">
                    <span className="text-muted">{s.label}</span> <b className={pnlClass(s.pnl)}>{rupees(s.pnl)}</b>
                  </span>
                </span>
              ))}
            </div>
          )}
          <Lessons items={d.lessons} />
          {d.chart.length > 0 && (
            <div className="space-y-1.5">
              {option && d.indexChart.length > 0 && (
                <Segmented size="sm" className="w-full" value={view} onChange={setView} options={[{ value: 'trade', label: 'Option premium' }, { value: 'index', label: 'Index chart' }]} />
              )}
              <div className="num min-h-4 text-[11px] text-muted">
                {pickedRow ? (
                  <>
                    {clockOf(pickedRow.time)} · minute {pickedRow.min} · {option ? 'premium' : 'price'} {formatPrice(pickedRow.close)} · P&amp;L <b className={pnlClass(pickedRow.pnl)}>{rupees(pickedRow.pnl)}</b>
                    {pickedRow.stop != null && ` · stop ${formatPrice(pickedRow.stop)}`}
                  </>
                ) : (
                  'Bars under the candles are the P&L each minute. The red line is the stop. Tap a minute.'
                )}
              </div>
              {view === 'index' && option ? (
                <ReplayChart candles={d.indexChart} minutes={d.minutes} entry={d.entry} exit={{ ...d.exit, level: d.minutes.at(-1)?.spot }} long={d.side === 'CE'} stopKey="spotStop" entryLevel={d.entry.spot} picked={picked} onPick={setPicked} />
              ) : (
                <ReplayChart candles={d.chart} minutes={d.minutes} entry={d.entry} exit={{ ...d.exit, level: d.exit.price }} long={long} stopKey="stop" entryLevel={d.entry.price} picked={picked} onPick={setPicked} />
              )}
            </div>
          )}
          {d.minutes.length > 0 && <MinuteTable data={d} picked={picked} onPick={setPicked} />}
          <WhyTaken why={d.why} side={d.side} />
          <SkipRules s={d.skips} />
          <PlanVsResult d={d} />
          <p className="text-center text-[11px] text-muted">{d.note}</p>
        </div>
      )}
    </Sheet>
  );
}
