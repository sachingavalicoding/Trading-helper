import { useState } from 'react';
import { Check, Play, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { useStudy } from '../../lib/useStudy.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { istStamp } from '../../lib/study.js';
import { FAMILY_LABEL, BAND_CHOICES, movedBandWords, isApplied, skippedWords, measureLine } from '../../lib/movedTest.js';
import { loadIndex, saveIndex } from '../../lib/indexes.js';
import { Badge, Card, Fold, Segmented, Skeleton } from '../ui.jsx';
import { JobStatus } from '../JobStatus.jsx';

const EXIT = { LOCK: 'ladder', STOP: 'stop', HARD: 'hard stop', EOD: 'close time', TRAIL: 'trail', BREAKEVEN: 'break-even' };

const Money = ({ v, className = '' }) => <span className={`num font-semibold ${pnlClass(v)} ${className}`}>{formatPnl(v)}</span>;

/** One limit's money: all days, the older days it was picked on and the newest days it never saw. */
function Numbers({ r }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 text-center text-[11px]">
      {[
        ['All days', r.all, true],
        ['Older days', r.fit],
        ['Newest days', r.check],
      ].map(([label, m, all]) => (
        <div key={label} className="rounded-lg bg-surface-2 p-1.5">
          <div className="text-muted">{label}</div>
          <Money v={m.net} className="text-sm" />
          <div className="text-muted">
            {m.trades} trades{all ? ` · ${m.winRate ?? '–'}% win` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Research > Already moved: the live entries replayed with and without a limit on how far the market had already run before the buy. */
export function MovedTester() {
  const { state, error, running, run } = useStudy('moved');
  const [index, setIndex] = useState(loadIndex);
  const [band, setBand] = useState('run30');
  const options = useApi('/options');
  const [busy, setBusy] = useState(false);
  const r = state?.result;
  const s = options.data?.settings;

  async function apply(row) {
    setBusy(true);
    try {
      await api('/options', { method: 'PUT', body: row.apply });
      toast.success(row.key === 'off' ? 'Saved. The already-moved and premium checks are off.' : `Saved. From now on: ${row.text}`);
      options.reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const pickIndex = (v) => {
    setIndex(v);
    saveIndex(v);
  };

  const off = r?.rows?.find((x) => x.key === 'off');
  const rec = r?.rows?.find((x) => x.key === r.advice?.key);
  const bestOf = (r?.families ?? []).map((f) => r.rows.find((x) => x.key === f.best)).filter(Boolean);
  const applied = (row) => isApplied(row, s);
  const UseButton = ({ row, primary = false }) =>
    applied(row) ? (
      <span className="flex items-center gap-1 text-xs text-up">
        <Check className="h-4 w-4" /> In use
      </span>
    ) : (
      <button type="button" className={`btn ${primary ? 'btn-primary w-full' : 'btn-secondary btn-sm'}`} disabled={busy || !s} onClick={() => apply(row)}>
        {primary ? 'Use this check' : 'Use'}
      </button>
    );

  return (
    <div className="space-y-3">
      <Card className="space-y-2 p-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <TrendingUp className="h-4 w-4 text-accent" /> Already moved?
        </h2>
        <p className="text-[11px] leading-snug text-muted">
          Do late entries lose? This takes the entries your auto trader would have taken on the real option prices saved for the last 30 days, and replays them again with a limit on how far the market had <b className="text-fg">already run before the buy</b>: the index from its 30 or 60-minute low, since the open, from the day average, its RSI, the option premium from its own low, and a last time for a new trade. Each limit is <b className="text-fg">picked on the older two thirds of the days</b> and only recommended if it also did better on the <b className="text-fg">newest third</b>, which it never saw. Nothing changes until you tap Use.
        </p>
        <button type="button" className="btn btn-primary w-full" disabled={running} onClick={() => run(30, { index })}>
          <Play className="h-4 w-4" /> {running ? 'Running…' : 'Test on the saved prices'}
        </button>
        {running && <JobStatus state="running" title="Already-moved test" step={state?.status?.step} startedAt={state?.status?.startedAt} note="About a minute. You can leave this page." />}
        {state?.status?.state === 'failed' && <JobStatus state="failed" title="Already-moved test stopped" error={state.status.error} />}
        {error && <JobStatus state="failed" title="Could not load" error={error} />}
        {s && (
          <p className="text-[11px] text-muted">
            Now: {s.movedText ?? 'no already-moved check'}
            {s.chasePct > 0 ? ` · premium check over ${s.chasePct}% above its ${s.chaseMinutes}-minute low` : ''}
            {s.pausedToday ? ' · new buys paused for today' : ''}
          </p>
        )}
      </Card>

      {!state && <Skeleton className="h-40 w-full" />}
      {state && !r && !running && <p className="px-1 text-xs text-muted">No test run yet. Tap the button above: it takes about a minute.</p>}

      {r && off && (
        <>
          <p className="px-1 text-[11px] text-muted">
            Nifty · {r.period.from} to {r.period.to} ({r.period.days} days with real prices{r.period.checkFrom ? `; older ${r.period.fitDays} days pick, newest ${r.period.checkDays} from ${r.period.checkFrom} check` : ''}) · {r.signals} entry signals · run {istStamp(Date.parse(r.generatedAt) / 1000)}
          </p>

          <Card className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-sm font-semibold">What the data says</h3>
              <Badge tone={r.advice.verdict === 'on' ? 'up' : 'muted'}>{r.advice.verdict === 'on' ? 'A check helps' : 'No check needed'}</Badge>
            </div>
            <p className="text-xs">{r.advice.text}</p>
            <div className={`grid gap-2 ${rec ? 'sm:grid-cols-2' : ''}`}>
              <div className="space-y-1.5 rounded-xl border border-line p-2">
                <div className="text-xs font-semibold">Take every entry (no check)</div>
                <Numbers r={off} />
              </div>
              {rec && (
                <div className="space-y-1.5 rounded-xl border border-up/50 p-2">
                  <div className="text-xs font-semibold">Recommended: {rec.label}</div>
                  <p className="text-[11px] text-muted">{rec.text}</p>
                  <Numbers r={rec} />
                  <p className="text-[11px]">{skippedWords(rec.vsOff)}</p>
                  <UseButton row={rec} primary />
                </div>
              )}
            </div>
            {(s?.movedCheck !== 'off' || s?.chasePct > 0) && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => apply(off)}>
                Turn the checks off
              </button>
            )}
          </Card>

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">The best limit of each kind</h3>
            <p className="text-[11px] text-muted">Picked on the older days (each scored with its neighbours, so one lucky number does not win). "Newest" is the money on the days it never saw, against {formatPnl(off.check.net)} with no check.</p>
            {bestOf.map((x) => (
              <div key={x.key} className="space-y-0.5 border-t border-line pt-1.5 text-[11px]">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">
                    {x.label}
                    <span className="block font-normal text-muted">{FAMILY_LABEL[x.family]}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Money v={x.all.net} />
                    <UseButton row={x} />
                  </span>
                </div>
                <p className="num text-muted">
                  older <Money v={x.fit.net} /> · newest <Money v={x.check.net} /> · {skippedWords(x.vsOff)}
                </p>
              </div>
            ))}
            {!bestOf.length && <p className="text-[11px] text-muted">Too few trades to judge any limit.</p>}
          </Card>

          <Card className="space-y-2 p-3">
            <h3 className="text-sm font-semibold">Did entries after a big move really lose?</h3>
            <p className="text-[11px] text-muted">Every entry with no check, grouped by how far the move had already gone at the buy.</p>
            <Segmented size="sm" cols={3} value={band} onChange={setBand} options={BAND_CHOICES} />
            <div className="space-y-0.5 text-[11px]">
              {(r.bands?.[band] ?? []).map((b) => (
                <div key={`${b.from}-${b.to}`} className="num flex justify-between gap-2">
                  <span>{movedBandWords(band, b)}</span>
                  <span className="text-muted">
                    {b.trades} trades · {b.wins} won · <Money v={b.net} />
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Fold id="moved-all" title="Every limit tried" summary={`${r.rows.length} rows: money, and the winners and losers each skipped`}>
            <div className="space-y-1">
              {r.rows.map((x) => (
                <div key={x.key} className="num flex items-center justify-between gap-2 border-t border-line py-1 text-[11px] first:border-0">
                  <span className="min-w-0">
                    {x.label} {x.key === r.advice.key && <Badge tone="up">Pick</Badge>}
                    <span className="block text-muted">
                      {x.all.trades} trades · older <Money v={x.fit.net} /> · newest <Money v={x.check.net} />
                      {x.key !== 'off' ? ` · ${skippedWords(x.vsOff)}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Money v={x.all.net} />
                    {x.apply && x.key !== 'off' && <UseButton row={x} />}
                  </span>
                </div>
              ))}
            </div>
          </Fold>

          {r.trades?.length > 0 && (
            <Fold id="moved-trades" title="Each entry and how far the move had gone" summary={`The newest ${r.trades.length}, with no check`}>
              <div className="space-y-1">
                {r.trades.map((t) => (
                  <div key={`${t.entryTime}-${t.side}`} className="num flex items-center justify-between gap-2 border-t border-line py-1 text-[11px] first:border-0">
                    <span className="min-w-0">
                      {istStamp(t.entryTime)} · {t.strike} {t.side} at ₹{t.entryPremium} · sold by {EXIT[t.reason] ?? t.reason}
                      <span className="block text-muted">{measureLine(t)}</span>
                    </span>
                    <Money v={t.net} className="shrink-0" />
                  </div>
                ))}
              </div>
            </Fold>
          )}
          <p className="px-1 text-[11px] text-muted">{state.note}</p>
        </>
      )}
    </div>
  );
}
