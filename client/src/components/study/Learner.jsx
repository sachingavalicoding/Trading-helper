import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, Play, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { istStamp } from '../../lib/study.js';
import { Switch } from '../options/OptionsAutoCard.jsx';
import { Badge, Card, Fold, Segmented, Skeleton } from '../ui.jsx';

const KINDS = [
  { value: 'options', label: 'Options' },
  { value: 'shares', label: 'Shares' },
];
const VERDICT = { found: ['up', 'Found one'], none: ['muted', 'No edge found'], short: ['warn', 'Not enough days'], failed: ['down', 'Did not run'] };
const ACTION = { checked: 'Checked', added: 'Added', replaced: 'Replaced', kept: 'Kept', paused: 'Switched off', benched: 'Switched off (live losses)', used: 'Used by you', undone: 'Undone' };

const Money = ({ v, className = '' }) => <span className={`num font-semibold ${pnlClass(v)} ${className}`}>{formatPnl(v)}</span>;
const stamp = (iso) => istStamp(Date.parse(iso) / 1000);

/** The words under the numbers: what "older" and "newest" mean for this run. */
export function splitWords(last) {
  if (!last?.trainDays) return '';
  const prices = last.pricing === 'estimated' ? ' Option prices are estimated (fewer than 15 days of real prices are saved).' : last.pricing === 'real' ? ' Real saved option prices.' : '';
  return `Picked on the older ${last.trainDays} days, then checked on the newest ${last.testDays} days it never saw. After charges.${prices}`;
}

/** Three boxes: the pick on the older days, on the newest days, and your current combinations on the newest days. */
function Numbers({ pick, baseline }) {
  const boxes = [
    ['Older days (picked)', pick.train],
    ['Newest days (never seen)', pick.test],
    ['Your combinations, newest days', baseline?.test],
  ];
  return (
    <div className="grid grid-cols-3 gap-1.5 text-center text-[11px]">
      {boxes.map(([label, m]) => (
        <div key={label} className="rounded-lg bg-surface-2 p-1.5">
          <div className="leading-tight text-muted">{label}</div>
          <Money v={m?.net ?? 0} className="text-sm" />
          <div className="text-muted">
            {m?.trades ?? 0} trades{m?.winRate != null ? ` · ${m.winRate}% win` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Research > Auto-learner: one card, one switch. It looks for a better combination on the saved days and, with auto on, uses it on paper. */
export function Learner() {
  const [kind, setKind] = useState('options');
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      setView(await api(`/learner/${kind}`));
    } catch (e) {
      toast.error(e.message || 'Could not load the learner');
    }
  }, [kind]);

  useEffect(() => {
    setView(null);
    load();
    return () => clearTimeout(timer.current);
  }, [load]);

  const running = view?.status?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    timer.current = setTimeout(load, 2500);
    return () => clearTimeout(timer.current);
  }, [running, view, load]);

  async function act(path, { method = 'POST', body, done } = {}) {
    setBusy(true);
    try {
      const next = await api(`/learner/${kind}${path}`, { method, body });
      if (next?.kind) setView((v) => ({ ...v, ...next }));
      else await load();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(e.message || 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  const last = view?.last;
  const [tone, word] = VERDICT[last?.verdict] ?? ['muted', ''];
  const slot = view?.slot;
  const pickInUse = slot && last?.pick && slot.on && [...slot.conds].sort().join() === [...last.pick.conds].sort().join() && (slot.side ?? null) === (last.pick.side ?? null);

  return (
    <div className="space-y-3">
      <Segmented size="sm" cols={2} value={kind} onChange={setKind} options={KINDS} />
      {!view && <Skeleton className="h-48 w-full" />}
      {view && (
        <Card className="space-y-3 p-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Brain className="h-4 w-4 text-accent" /> Auto-learner ({kind === 'shares' ? 'shares' : 'Nifty options'})
          </h2>
          <p className="text-[11px] leading-snug text-muted">
            Every trading evening it tries hundreds of combinations on the last {kind === 'shares' ? 15 : 30} saved days. It picks on the <b className="text-fg">older days</b>, and keeps a pick only if it also made money on the <b className="text-fg">newest days it never saw</b>, after charges, and did better there than your current combinations. Most evenings it may find nothing, and that is the honest answer.
          </p>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-2.5">
            <span className="min-w-0 text-xs">
              <span className="block font-semibold">Use the best by itself (paper)</span>
              <span className="block text-[11px] text-muted">{view.auto ? 'On: each evening it puts its pick in your combinations, or switches it off when it stops working.' : 'Off: it only suggests. Nothing changes until you tap Use it.'}</span>
            </span>
            <Switch on={view.auto} disabled={busy} label="Use the best by itself" onClick={() => act('/auto', { method: 'PUT', body: { on: !view.auto }, done: view.auto ? 'Auto off: it will only suggest.' : 'Auto on: it will use what passes, on paper.' })} />
          </div>

          <button type="button" className="btn btn-secondary w-full" disabled={running || busy} onClick={() => act('/run')}>
            <Play className="h-4 w-4" /> {running ? view.status.step || 'Learning…' : 'Learn now (a few minutes)'}
          </button>

          {view.simulated && <p className="text-[11px] text-warn">The app is on the practice feed: its history is random, so results mean nothing and auto never changes anything here.</p>}
          {view.traderOff && <p className="text-[11px] text-warn">{kind === 'shares' ? 'Auto shares is off in Account, so a pick will not trade until you turn it on.' : 'The options auto trader or combination entries are off in Account, so a pick will not trade until you turn them on.'}</p>}

          {!last && !running && <p className="text-xs text-muted">Not run yet. Tap Learn now, or turn the switch on and it runs after 16:30 on trading days.</p>}
          {last && (
            <div className="space-y-2 border-t border-line pt-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={tone}>{word}</Badge>
                <span className="text-[11px] text-muted">
                  {stamp(last.at)}
                  {last.by === 'evening' ? ' · evening run' : ''}
                  {last.tried ? ` · ${last.tried} tries` : ''}
                </span>
              </div>
              <p className="text-xs">{last.text}</p>
              {last.pick && (
                <>
                  <div className="rounded-xl border border-up/50 p-2">
                    <div className="text-xs font-semibold">{last.pick.labels.join(' + ')}</div>
                    <div className="mb-1.5 text-[11px] text-muted">{last.pick.sideText} · all checks must hold</div>
                    <Numbers pick={last.pick} baseline={last.baseline} />
                  </div>
                  {!pickInUse && (
                    <button type="button" className="btn btn-primary w-full" disabled={busy || running} onClick={() => act('/use', { done: 'Added to your combinations (paper).' })}>
                      Use it
                    </button>
                  )}
                </>
              )}
              <p className="text-[11px] text-muted">{splitWords(last)}</p>
            </div>
          )}

          {slot && (
            <div className="flex items-center justify-between gap-2 border-t border-line pt-2 text-xs">
              <span className="min-w-0">
                <span className="block font-semibold">{slot.on ? 'In use now' : 'Saved, switched off'}</span>
                <span className="block text-[11px] text-muted">
                  {slot.name}
                  {slot.benchedOn ? ` · off since ${slot.benchedOn} after live losses` : ''}
                </span>
              </span>
              <button type="button" className="btn btn-secondary btn-sm shrink-0" disabled={busy} onClick={() => act('/undo', { done: 'Undone: the learner combination is out and auto is off.' })}>
                <Undo2 className="h-4 w-4" /> Undo
              </button>
            </div>
          )}
        </Card>
      )}

      {last?.candidates?.length > 0 && (
        <Fold id={`learner-tried-${kind}`} title="What it checked" summary={`The best ${last.candidates.length} on the older days, and why each passed or not`}>
          <div className="space-y-1.5">
            {last.candidates.map((c) => (
              <div key={`${c.conds.join('+')}|${c.side}`} className="space-y-0.5 border-t border-line pt-1.5 text-[11px] first:border-0 first:pt-0">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">
                    {c.labels.join(' + ')} <span className="font-normal text-muted">· {c.sideText}</span>
                  </span>
                  <Badge tone={c.passed ? 'up' : 'muted'}>{c.passed ? 'Passed' : 'No'}</Badge>
                </div>
                <p className="num text-muted">
                  older <Money v={c.train.net} /> ({c.train.trades}) · newest <Money v={c.test.net} /> ({c.test.trades})
                </p>
                {!c.passed && <p className="text-muted">{c.why.join('; ')}</p>}
              </div>
            ))}
          </div>
        </Fold>
      )}

      {view?.log?.length > 0 && (
        <Fold id={`learner-log-${kind}`} title="What it changed" summary="Each run and change, and how a pick then did live">
          <div className="space-y-1.5">
            {view.log.map((e, n) => (
              <div key={`${e.at}-${n}`} className="space-y-0.5 border-t border-line pt-1.5 text-[11px] first:border-0 first:pt-0">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">
                    {ACTION[e.action] ?? e.action}
                    {e.name && e.action !== 'checked' ? `: ${e.name.replace(/^Learner: /, '')}` : ''}
                  </span>
                  <span className="shrink-0 text-muted">{stamp(e.at)}</span>
                </div>
                {e.action === 'checked' ? <p className="text-muted">{e.text}</p> : e.text && <p className="text-muted">{e.text}</p>}
                {e.live && (
                  <p className="num">
                    Live since: {e.live.trades} trades, {e.live.wins} won, <Money v={e.live.net} />
                    {e.live.ended ? ' (until the next change)' : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Fold>
      )}
      {view?.note && <p className="px-1 text-[11px] text-muted">{view.note}</p>}
    </div>
  );
}
