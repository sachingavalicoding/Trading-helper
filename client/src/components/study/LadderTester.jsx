import { useState } from 'react';
import { Check, Layers, Play, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { useStudy } from '../../lib/useStudy.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { istStamp } from '../../lib/study.js';
import { bandWords, chaseWords, rungLines, sameSteps } from '../../lib/ladderTest.js';
import { loadIndex, saveIndex } from '../../lib/indexes.js';
import { Badge, Card, Fold, Segmented, Skeleton } from '../ui.jsx';
import { JobStatus } from '../JobStatus.jsx';

const EXIT = { LOCK: 'ladder', STOP: 'stop', HARD: 'hard stop', EOD: 'close time', TRAIL: 'trail', BREAKEVEN: 'break-even' };

const Money = ({ v, className = '' }) => <span className={`num font-semibold ${pnlClass(v)} ${className}`}>{formatPnl(v)}</span>;

/** One ladder's numbers: all days, the older days it was picked on and the newest days it never saw. */
function Numbers({ r }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 text-center text-[11px]">
      <div className="rounded-lg bg-surface-2 p-1.5">
        <div className="text-muted">All days</div>
        <Money v={r.all.net} className="text-sm" />
        <div className="text-muted">{r.all.trades} trades · {r.all.winRate ?? '–'}% win</div>
      </div>
      <div className="rounded-lg bg-surface-2 p-1.5">
        <div className="text-muted">Older days</div>
        <Money v={r.fit.net} className="text-sm" />
        <div className="text-muted">{r.fit.trades} trades</div>
      </div>
      <div className="rounded-lg bg-surface-2 p-1.5">
        <div className="text-muted">Newest days</div>
        <Money v={r.check.net} className="text-sm" />
        <div className="text-muted">{r.check.trades} trades</div>
      </div>
      <div className="col-span-3 text-left text-[11px] text-muted">
        Kept {r.all.kept ?? '–'}% of the best profit (gave back ₹{Math.round(r.all.gaveBack ?? 0).toLocaleString('en-IN')} a trade on average) · {r.all.reversed} trade{r.all.reversed === 1 ? '' : 's'} up ₹1,500+ that ended in a loss · worst run {formatPnl(-(r.all.maxDrawdown ?? 0))}
      </div>
      {r.key !== 'current' && r.tradeOff && <TradeOff o={r.tradeOff} />}
    </div>
  );
}

/** Against your ladder on the same entries: trades saved from a loss, and big winners cut short. */
function TradeOff({ o, className = 'col-span-3' }) {
  return (
    <div className={`${className} grid grid-cols-2 gap-1.5 text-left text-[11px]`}>
      <div className="rounded-lg bg-up-soft p-1.5">
        <div className="font-semibold text-up">Saved {o.saved} from a loss</div>
        <div className="text-muted">yours was up ₹1,500 and lost; this one did not · {formatPnl(o.savedRs)}</div>
      </div>
      <div className="rounded-lg bg-down-soft p-1.5">
        <div className="font-semibold text-down">Cut {o.cut} big winner{o.cut === 1 ? '' : 's'}</div>
        <div className="text-muted">yours ended ₹3,000+ up, this one ₹1,000+ less · {formatPnl(o.cutRs)}</div>
      </div>
    </div>
  );
}

function Rungs({ steps }) {
  return (
    <ul className="num space-y-0.5 text-[11px]">
      {rungLines(steps).map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

/** Research > Ladder tester: the live entries replayed on the saved real option prices with many profit ladders, and the anti-chase check. */
export function LadderTester() {
  const { state, error, running, run } = useStudy('ladder');
  const [index, setIndex] = useState(loadIndex);
  const defaults = useApi('/trade-defaults');
  const options = useApi('/options');
  const [busy, setBusy] = useState(false);
  const r = state?.result;
  const key = r?.applyKey ?? 'options';
  const savedSteps = defaults.data?.[key]?.steps ?? null;
  const savedChase = options.data?.settings ? { pct: options.data.settings.chasePct ?? 0, minutes: options.data.settings.chaseMinutes ?? 15 } : null;

  async function applyLadder(row) {
    setBusy(true);
    try {
      await api('/trade-defaults', { method: 'PUT', body: { [key]: { steps: row.steps, lockOn: true } } });
      toast.success(`Saved. New option trades now use: ${row.label}.`);
      defaults.reload();
    } catch (e) {
      toast.error(e.message || 'Could not save the ladder');
    } finally {
      setBusy(false);
    }
  }

  async function applyChase(pct, minutes) {
    setBusy(true);
    try {
      await api('/options', { method: 'PUT', body: pct > 0 ? { chasePct: pct, chaseMinutes: minutes } : { chasePct: 0 } });
      toast.success(pct > 0 ? `Saved. The auto trader now skips a premium over ${pct}% above its ${minutes}-minute low.` : 'Saved. The anti-chase check is off.');
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

  const rec = r?.rows?.find((x) => x.key === r.advice?.key);
  const current = r?.rows?.find((x) => x.key === 'current');
  const isSaved = (steps) => savedSteps != null && sameSteps(steps, savedSteps);
  const protect = r?.protect ? r.rows.find((x) => x.key === r.protect.key) : null;
  const chasePick = r?.chase?.rows?.find((x) => x.key === r.chase.advice?.key);

  return (
    <div className="space-y-3">
      <Card className="space-y-2 p-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Layers className="h-4 w-4 text-accent" /> Profit ladder tester
        </h2>
        <p className="text-[11px] leading-snug text-muted">
          Takes the entries your auto trader would have taken (your patterns and the combinations switched on, with your stop, lots and daily limits) on the real option prices saved for the last 30 days, and sells each trade again with about 30 profit ladders. A ladder is <b className="text-fg">picked on the older two thirds of the days</b> and then <b className="text-fg">checked on the newest third</b>, which it never saw, so a ladder that only fits the past is not recommended. Nothing changes until you tap Use.
        </p>
        <button type="button" className="btn btn-primary w-full" disabled={running} onClick={() => run(30, { index })}>
          <Play className="h-4 w-4" /> {running ? 'Running…' : 'Test ladders on the saved prices'}
        </button>
        {running && <JobStatus state="running" title="Ladder test" step={state?.status?.step} startedAt={state?.status?.startedAt} note="About a minute. You can leave this page." />}
        {state?.status?.state === 'failed' && <JobStatus state="failed" title="Ladder test stopped" error={state.status.error} />}
        {error && <JobStatus state="failed" title="Could not load" error={error} />}
      </Card>

      {!state && <Skeleton className="h-40 w-full" />}
      {state && !r && !running && <p className="px-1 text-xs text-muted">No test run yet. Tap the button above: it takes about a minute.</p>}

      {r && (
        <>
          <p className="px-1 text-[11px] text-muted">
            Nifty · {r.period.from} to {r.period.to} ({r.period.days} days with real prices{r.period.checkFrom ? `; older ${r.period.fitDays} days pick, newest ${r.period.checkDays} from ${r.period.checkFrom} check` : ''}) · {r.signals} entry signals · run {istStamp(Date.parse(r.generatedAt) / 1000)}
          </p>

          <Card className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-sm font-semibold">What the data says</h3>
              <Badge tone={r.advice.verdict === 'change' ? 'up' : 'muted'}>{r.advice.verdict === 'change' ? 'Change suggested' : 'Keep yours'}</Badge>
            </div>
            <p className="text-xs">{r.advice.text}</p>
            <div className={`grid gap-2 ${rec && rec.key !== 'current' ? 'sm:grid-cols-2' : ''}`}>
              {current && (
                <div className="space-y-1.5 rounded-xl border border-line p-2">
                  <div className="text-xs font-semibold">Your ladder now {r.lockOn === false && <Badge tone="warn">lock off</Badge>}</div>
                  <Rungs steps={current.steps} />
                  <Numbers r={current} />
                </div>
              )}
              {rec && rec.key !== 'current' && (
                <div className="space-y-1.5 rounded-xl border border-up/50 p-2">
                  <div className="text-xs font-semibold">Recommended: {rec.label}</div>
                  <Rungs steps={rec.steps} />
                  <Numbers r={rec} />
                  {isSaved(rec.steps) ? (
                    <p className="flex items-center gap-1 text-xs text-up"><Check className="h-4 w-4" /> In use now</p>
                  ) : (
                    <button type="button" className="btn btn-primary w-full" disabled={busy} onClick={() => applyLadder(rec)}>
                      Use this ladder
                    </button>
                  )}
                </div>
              )}
            </div>
            {r.ownLadder > 0 && <p className="text-[11px] text-warn">{r.ownLadder} of your combinations have their own ladder. Their trades keep it in this test, and Use does not change it.</p>}
            {r.combosSkipped?.length > 0 && <p className="text-[11px] text-muted">Not in the test (data missing): {r.combosSkipped.join(', ')}.</p>}
          </Card>

          {protect && (
            <Card className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="text-sm font-semibold">Stop trades from going +₹1,500 to a loss</h3>
                <Badge tone={r.protect.verdict === 'holds' ? 'up' : 'warn'}>{r.protect.verdict === 'holds' ? 'Held up on the newest days' : 'Costs money on the newest days'}</Badge>
              </div>
              <p className="text-[11px] text-muted">The best ladder that moves the stop to break-even (or better) by +₹1,500, so a trade that was up ₹1,500 can no longer end in a loss. The price is that a trade which dips back after +₹1,500 and then runs to a big win gets sold at break-even instead.{protect.key === r.advice.key ? ' It is also the recommended ladder above.' : ''}</p>
              <p className="text-xs">{r.protect.text}</p>
              <div className="font-semibold text-xs">{protect.label}</div>
              <Rungs steps={protect.steps} />
              <Numbers r={protect} />
              {isSaved(protect.steps) ? (
                <p className="flex items-center gap-1 text-xs text-up"><Check className="h-4 w-4" /> In use now</p>
              ) : (
                <button type="button" className={`btn w-full ${r.protect.verdict === 'holds' ? 'btn-primary' : 'btn-secondary'}`} disabled={busy} onClick={() => applyLadder(protect)}>
                  Use this ladder
                </button>
              )}
            </Card>
          )}

          <Card className="space-y-2 p-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <ShieldAlert className="h-4 w-4 text-accent" /> Anti-chase check
            </h3>
            <p className="text-[11px] text-muted">Skips a buy when the option price has already run far up from its low of the last minutes, like the 3 Nov call bought after a spike. Tried with {r.chosen.key === 'current' ? 'your ladder' : 'the recommended ladder'}.</p>
            <p className="text-xs">{r.chase.advice.text}</p>
            <p className="text-[11px] text-muted">Now: {chaseWords(savedChase)}</p>
            {r.riseBands?.some((b) => b.trades) && (
              <div className="space-y-0.5 text-[11px]">
                <div className="font-semibold">Your trades by how far the premium had already risen at the buy</div>
                {r.riseBands.map((b) => (
                  <div key={bandWords(b)} className="num flex justify-between gap-2">
                    <span>{bandWords(b)}</span>
                    <span className="text-muted">{b.trades} trades · {b.wins} won · <Money v={b.net} /></span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {chasePick && chasePick.key !== 'off' && !(savedChase?.pct === chasePick.pct && savedChase?.minutes === chasePick.minutes) && (
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => applyChase(chasePick.pct, chasePick.minutes)}>
                  Use: skip over {chasePick.pct}% ({chasePick.minutes} min)
                </button>
              )}
              {savedChase?.pct > 0 && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => applyChase(0)}>
                  Turn the check off
                </button>
              )}
            </div>
            <Fold plain id="ladder-chase-rows" title="Every threshold tried" summary={`${r.chase.rows.length} settings`}>
              {r.chase.rows.map((x) => (
                <div key={x.key} className="num flex items-center justify-between gap-2 border-t border-line py-1 text-[11px]">
                  <span className="min-w-0">
                    {x.label}
                    <span className="block text-muted">{x.all.trades} trades{x.skipped ? `, ${x.skipped} skipped` : ''} · older <Money v={x.fit.net} /> · newest <Money v={x.check.net} /></span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Money v={x.all.net} />
                    {x.pct > 0 && !(savedChase?.pct === x.pct && savedChase?.minutes === x.minutes) && (
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => applyChase(x.pct, x.minutes)}>
                        Use
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </Fold>
          </Card>

          <Fold id="ladder-all" title="Every ladder tried" summary={`${r.rows.length} ladders, best on the older days first (each scored with its neighbours, so a lucky one does not win)`}>
            <div className="space-y-2">
              {r.rows.map((x) => (
                <div key={x.key} className="space-y-1 border-t border-line pt-2 first:border-0 first:pt-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1 text-xs font-semibold">
                        {x.label}
                        {x.key === r.advice.key && x.key !== 'current' && <Badge tone="up">Pick</Badge>}
                        {isSaved(x.steps) && <Badge tone="accent">In use</Badge>}
                      </div>
                      <p className="text-[11px] text-muted">{x.text}</p>
                    </div>
                    <Money v={x.all.net} className="shrink-0 text-sm" />
                  </div>
                  <p className="num text-[11px] text-muted">
                    {x.all.trades} trades · {x.all.winRate ?? '–'}% win · older <Money v={x.fit.net} /> · newest <Money v={x.check.net} /> · kept {x.all.kept ?? '–'}% · {x.all.reversed} up ₹1,500 then lost
                    {x.key !== 'current' && x.tradeOff ? ` · vs yours: saved ${x.tradeOff.saved}, cut ${x.tradeOff.cut} big winner${x.tradeOff.cut === 1 ? '' : 's'}` : ''}
                  </p>
                  {x.key !== 'current' && !isSaved(x.steps) && (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => applyLadder(x)}>
                      Use this one
                    </button>
                  )}
                </div>
              ))}
            </div>
          </Fold>

          {r.currentTrades?.length > 0 && (
            <Fold id="ladder-trades" title="Your ladder's trades in the test" summary={`The newest ${r.currentTrades.length}: best profit on the way and how each ended`}>
              <div className="space-y-1">
                {r.currentTrades.map((t) => (
                  <div key={`${t.entryTime}-${t.side}`} className="num flex items-center justify-between gap-2 border-t border-line py-1 text-[11px] first:border-0">
                    <span className="min-w-0">
                      {istStamp(t.entryTime)} · {t.strike} {t.side} · {t.lots} lot{t.lots > 1 ? 's' : ''} at ₹{t.entryPremium}
                      <span className="block text-muted">best {formatPnl(t.best)} · sold by {EXIT[t.reason] ?? t.reason}{t.rise != null ? ` · premium was up ${t.rise}% at the buy` : ''}</span>
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
