import { useState } from 'react';
import { ChevronDown, ClipboardCopy, FlaskConical, Play } from 'lucide-react';
import { toast } from 'sonner';
import { copyText } from '../../lib/copyText.js';
import { formatPnl, formatPrice, pnlClass } from '../../lib/format.js';
import { useStudy } from '../../lib/useStudy.js';
import { EXIT_WORD, hourRows, istStamp, sizingText, studyText, verdict } from '../../lib/study.js';
import { Badge, Card, Segmented, Skeleton } from '../ui.jsx';

const DAYS = [
  { value: 1, label: 'Today' },
  { value: 10, label: '10 days' },
  { value: 20, label: '20 days' },
  { value: 30, label: '30 days' },
];

function Technique({ t, bot }) {
  const [open, setOpen] = useState(false);
  const v = verdict(t);
  const vsBot = bot && t.key !== 'bot' ? t.net - bot.net : null;
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-start justify-between gap-3 p-3 text-left" aria-expanded={open}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold">{t.label}</h3>
            {t.key === 'bot' && <Badge tone="accent">Live now</Badge>}
            <Badge tone={v.tone}>{v.text}</Badge>
          </div>
          <p className="num mt-1 text-[11px] text-muted">
            {t.trades} trades · {t.winRate ?? '–'}% win · avg win {formatPnl(t.avgWin)} · avg loss {formatPnl(t.avgLoss)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="text-right">
            <div className={`num text-base font-bold ${pnlClass(t.net)}`}>{formatPnl(t.net)}</div>
            {vsBot != null && <div className={`num text-[10px] ${pnlClass(vsBot)}`}>{vsBot >= 0 ? '+' : '−'}₹{Math.abs(Math.round(vsBot)).toLocaleString('en-IN')} vs bot</div>}
          </div>
          <ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line p-3 text-xs">
          <p className="text-muted">{t.text}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini label="Calls" value={formatPnl(t.bySide.CE.net)} sub={`${t.bySide.CE.trades} trades`} tone={pnlClass(t.bySide.CE.net)} />
            <Mini label="Puts" value={formatPnl(t.bySide.PE.net)} sub={`${t.bySide.PE.trades} trades`} tone={pnlClass(t.bySide.PE.net)} />
            <Mini label="Best / worst" value={formatPnl(t.best)} sub={`worst ${formatPnl(t.worst)}`} tone={pnlClass(t.best)} />
            <Mini label="Worst losing run" value={formatPnl(-t.maxDrawdown)} sub={`avg hold ${t.avgMinutes ?? '–'} min`} tone="text-down" />
          </div>
          <p className="text-muted">
            {t.signals} signals · {t.skippedWide} skipped because the stop was too far · ended by {Object.entries(t.byExit).map(([k, n]) => `${EXIT_WORD[k] || k} ${n}`).join(', ') || '–'}
          </p>
          {hourRows(t).length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {hourRows(t).map((h) => (
                <span key={h.hour} className="num text-muted">
                  {h.hour} <b className={pnlClass(h.net)}>{formatPnl(h.net)}</b> ({h.trades})
                </span>
              ))}
            </div>
          )}
          {t.recent.length > 0 && (
            <div>
              <div className="mb-1 font-semibold">Latest trades</div>
              <ul className="divide-y divide-line">
                {t.recent.map((r) => (
                  <li key={`${r.entryTime}`} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 text-muted">
                      <b className="text-fg">{istStamp(r.entryTime)}</b> {r.side} · Nifty {formatPrice(r.entrySpot)} → {formatPrice(r.exitSpot)} · {EXIT_WORD[r.reason] || r.reason}
                    </span>
                    <span className={`num shrink-0 font-semibold ${pnlClass(r.net)}`}>{formatPnl(r.net)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Mini({ label, value, sub, tone }) {
  return (
    <div className="rounded-lg bg-surface-2 p-2">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`num text-sm font-bold ${tone || ''}`}>{value}</div>
      <div className="num text-[10px] text-muted">{sub}</div>
    </div>
  );
}

function CutList({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold text-muted">{title}</div>
      <ul className="divide-y divide-line text-xs">
        {rows.map((x) => (
          <li key={x.key} className="flex items-center justify-between gap-2 py-1.5">
            <span className="min-w-0">
              <b>{x.key}</b> <span className="text-muted">· {x.trades} trades · {x.winRate ?? '–'}% win</span>
            </span>
            <span className={`num shrink-0 font-semibold ${pnlClass(x.net)}`}>{formatPnl(x.net)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the live bot's own trades looked like when cut by how it entered, how high it scored and call or put. */
function BotBreakdown({ cut }) {
  if (!cut || !cut.bySide.length) return null;
  return (
    <Card className="space-y-3 p-3">
      <div>
        <h3 className="text-sm font-semibold">The current bot, cut three ways</h3>
        <p className="text-[11px] leading-snug text-muted">Which entries made the bot's money and which lost it. Small groups are luck more than skill.</p>
      </div>
      <CutList title="By how it entered" rows={cut.byTrigger} />
      <CutList title="By score" rows={cut.byScore} />
      <CutList title="Calls and puts" rows={cut.bySide} />
    </Card>
  );
}

function Breadth({ rows }) {
  if (!rows?.length) return null;
  return (
    <Card className="space-y-2 p-3">
      <div>
        <h3 className="text-sm font-semibold">Do the 50 stocks lead Nifty?</h3>
        <p className="text-[11px] leading-snug text-muted">The first time each day that this many of the 50 stocks sat below (or above) yesterday's close, and how many Nifty points it then moved in that direction.</p>
      </div>
      <table className="num w-full text-xs">
        <thead className="text-left text-[10px] text-muted">
          <tr>
            <th className="py-1 font-medium">Stocks</th>
            <th className="pr-3 font-medium">Times</th>
            <th className="pr-2 font-medium">Next 30 min</th>
            <th className="font-medium">Next 60 min</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((b) => (
            <tr key={`${b.share}${b.side}`}>
              <td className="py-1.5">
                {b.share}%+ {b.side === 'down' ? 'down' : 'up'}
              </td>
              <td className="pr-3">{b.episodes}</td>
              <td className={`pr-2 ${pnlClass(b.avg30)}`}>
                {b.avg30 == null ? '–' : `${b.avg30 > 0 ? '+' : ''}${b.avg30} pts`} <span className="text-muted">({b.hit30 ?? '–'}% right)</span>
              </td>
              <td className={pnlClass(b.avg60)}>
                {b.avg60 == null ? '–' : `${b.avg60 > 0 ? '+' : ''}${b.avg60} pts`} <span className="text-muted">({b.hit60 ?? '–'}% right)</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Replays past Nifty candles through each way of reading the chart and shows what each would have made as one-lot option trades. Analysis only. */
export function OptionsStudy() {
  const [days, setDays] = useState(20);
  const { state, error, running, run } = useStudy('options');

  async function copy() {
    const ok = await copyText(studyText(state.result));
    toast[ok ? 'success' : 'info'](ok ? 'Study copied. Paste it into the chat.' : 'Could not copy by itself.');
  }

  const r = state?.result;
  const bot = r?.techniques.find((t) => t.key === 'bot');
  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            <h3 className="text-sm font-semibold">Which way of reading the chart pays?</h3>
            <p className="text-[11px] leading-snug text-muted">Replays past Nifty candles. Each technique buys a call or put when its pattern shows, with a chart stop and your profit lock, lots sized to your loss limit, closed at 15:15. This does not change the live trading.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Segmented className="flex-1" size="sm" value={days} onChange={setDays} options={DAYS} />
          <button type="button" onClick={() => run(days)} disabled={running} className="btn btn-primary btn-sm shrink-0">
            <Play className="h-3.5 w-3.5" /> {running ? 'Running…' : 'Run study'}
          </button>
        </div>
        {running && <p className="text-xs text-muted">{state.status.step}. This takes a minute or two.</p>}
        {state?.status?.state === 'failed' && <p className="text-xs text-down">{state.status.error}</p>}
        {error && <p className="text-xs text-down">{error}</p>}
      </Card>

      {!state && !error && <Skeleton className="h-40 w-full" />}
      {state && !r && !running && state.status.state !== 'failed' && <Card className="p-4 text-center text-sm text-muted">No study yet. Pick the days and tap Run study.</Card>}

      {r && (
        <>
          {r.simulated && <Card className="border-warn p-3 text-xs text-warn">This was made on the sample feed, whose history is random, so the numbers mean nothing. Log in to Upstox and run it again.</Card>}
          <Card className="flex items-center justify-between gap-2 p-3 text-xs">
            <p className="text-muted">
              {r.period.from} to {r.period.to} · {r.period.days} trading days · {sizingText(r.params)} · profit lock +₹{r.params.lockStart} keeps ₹{r.params.lockStart - r.params.lockGap} · premiums estimated at {Math.round(r.params.iv * 100)}% volatility
            </p>
            <button type="button" onClick={copy} className="btn btn-sm shrink-0">
              <ClipboardCopy className="h-3.5 w-3.5" /> Copy
            </button>
          </Card>
          {r.techniques.map((t) => (
            <Technique key={t.key} t={t} bot={bot} />
          ))}
          <BotBreakdown cut={r.botBreakdown} />
          <Breadth rows={r.breadth} />
          {!r.haveBreadth && <p className="text-center text-[11px] text-muted">The 50 stocks did not load, so breadth was left out.</p>}
          <p className="text-center text-[11px] leading-snug text-muted">{state.note}</p>
        </>
      )}
    </div>
  );
}
