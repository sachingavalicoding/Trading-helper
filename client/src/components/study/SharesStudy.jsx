import { useState } from 'react';
import { ClipboardCopy, FlaskConical, Play } from 'lucide-react';
import { toast } from 'sonner';
import { copyText } from '../../lib/copyText.js';
import { formatPnl, formatPrice, pnlClass } from '../../lib/format.js';
import { FEW_TRADES, istStamp, sharesExitText, sharesText } from '../../lib/study.js';
import { useStudy } from '../../lib/useStudy.js';
import { Badge, Card, Segmented, Skeleton } from '../ui.jsx';
import { ExitTimeField, useExitTime } from './ExitTimeField.jsx';
import { IndicatorRanking } from './IndicatorRanking.jsx';
import { PairFinder, PairFinderControl } from './PairFinder.jsx';
import { AutoFound } from './AutoFound.jsx';

const DAYS = [
  { value: 1, label: 'Today' },
  { value: 5, label: '5 days' },
  { value: 10, label: '10 days' },
  { value: 15, label: '15 days' },
];

function Group({ title, rows, note }) {
  if (!rows?.length) return null;
  return (
    <Card className="space-y-1 p-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {note && <p className="text-[11px] leading-snug text-muted">{note}</p>}
      </div>
      <ul className="divide-y divide-line">
        {rows.map((x) => (
          <li key={x.key} className="flex items-center justify-between gap-2 py-1.5 text-xs">
            <span className="min-w-0">
              <b>{x.key}</b> <span className="text-muted">· {x.trades} trades · {x.winRate ?? '–'}% win · avg win {formatPnl(x.avgWin)} · avg loss {formatPnl(x.avgLoss)}</span>
              {x.trades < FEW_TRADES && (
                <>
                  {' '}
                  <Badge>few trades</Badge>
                </>
              )}
            </span>
            <span className={`num shrink-0 text-sm font-bold ${pnlClass(x.totalNet)}`}>{formatPnl(x.totalNet)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The user's own combinations (Account > Entries), traded on the 50 stocks like the scanner's ideas. */
function ComboRows({ rows }) {
  if (!rows?.length) return null;
  return (
    <Card className="space-y-1 p-3">
      <div>
        <h3 className="text-sm font-semibold">My combinations</h3>
        <p className="text-[11px] leading-snug text-muted">The combinations you built, on every stock, one idea per side per stock per day. Halves show whether the older and the newer half of the period agree.</p>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((x) => (
          <li key={x.key} className="space-y-0.5 py-2 text-xs">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 font-semibold">
                {x.label.replace('My combination: ', '')} {x.trades < FEW_TRADES && <Badge>few trades</Badge>}
              </span>
              <span className={`num shrink-0 text-sm font-bold ${pnlClass(x.totalNet)}`}>{formatPnl(x.totalNet)}</span>
            </div>
            <p className="num text-[11px] text-muted">
              {x.trades} trades · {x.winRate ?? '–'}% win · avg win {formatPnl(x.avgWin)} · avg loss {formatPnl(x.avgLoss)} · Buys {formatPnl(x.buys.net)} ({x.buys.trades}) · Sells {formatPnl(x.sells.net)} ({x.sells.trades}) · halves {formatPnl(x.halves[0])} / {formatPnl(x.halves[1])}
            </p>
            <p className="text-[11px] leading-snug text-muted">{x.text}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Stat({ label, value, tone, sub }) {
  return (
    <div className="rounded-lg bg-surface-2 p-2">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`num text-sm font-bold ${tone || ''}`}>{value}</div>
      {sub && <div className="num text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

/** Replays the scanner on past candles of the Nifty 50 and shows which setups, hours and sides paid. Analysis only. */
export function SharesStudy() {
  const [days, setDays] = useState(10);
  const [exit, setExit] = useState('lock');
  const [target, setTarget] = useState('300');
  const [pair, setPair] = useState(false);
  const [pairFirst, setPairFirst] = useState('');
  const [finder, setFinder] = useState(false);
  const { state, error, running, run } = useStudy('shares');
  const time = useExitTime('shares');
  const targetValue = Number(target);
  const targetBad = exit === 'target' && !(targetValue >= 100 && targetValue <= 100000);
  const r = state?.result;
  const o = r?.overall;

  async function copy() {
    const ok = await copyText(sharesText(r));
    toast[ok ? 'success' : 'info'](ok ? 'Study copied. Paste it into the chat.' : 'Could not copy by itself.');
  }

  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            <h3 className="text-sm font-semibold">Which share setups pay?</h3>
            <p className="text-[11px] leading-snug text-muted">Replays the scanner on past candles of the 50 stocks, sized to your share stop. Choose how a winning trade is sold below. This does not change the live trading. It reads a lot of data, so it takes a few minutes.</p>
          </div>
        </div>
        <Segmented className="w-full" size="sm" value={exit} onChange={setExit} options={[{ value: 'lock', label: 'Profit ladder (your Account rows)' }, { value: 'target', label: 'Fixed target' }]} />
        {exit === 'target' && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>Sell when a trade's profit reaches (₹). No profit lock.</span>
            <input className="field num !w-24 !px-2 !py-1.5 text-right !text-sm" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target profit per trade in rupees" />
          </label>
        )}
        <ExitTimeField time={time} />
        <PairFinderControl on={pair} setOn={setPair} first={pairFirst} setFirst={setPairFirst} finder={finder} setFinder={setFinder} kind="shares" />
        {targetBad && <p className="text-xs text-down">The target must be between ₹100 and ₹1,00,000.</p>}
        <div className="flex items-center gap-2">
          <Segmented className="flex-1" size="sm" value={days} onChange={setDays} options={DAYS} />
          <button type="button" onClick={() => run(days, { exit, target: targetValue || 300, exitMin: time.exitMin, pairFind: pair, pairFirst: pairFirst || undefined, comboFind: finder })} disabled={running || targetBad || time.exitMin == null} className="btn btn-primary btn-sm shrink-0">
            <Play className="h-3.5 w-3.5" /> {running ? 'Running…' : 'Run study'}
          </button>
        </div>
        {running && <p className="text-xs text-muted">{state.status.step}. This takes a few minutes.</p>}
        {state?.status?.state === 'failed' && <p className="text-xs text-down">{state.status.error}</p>}
        {error && <p className="text-xs text-down">{error}</p>}
      </Card>

      {!state && !error && <Skeleton className="h-40 w-full" />}
      {state && !r && !running && state.status.state !== 'failed' && <Card className="p-4 text-center text-sm text-muted">No study yet. Pick the days and tap Run study.</Card>}

      {r && (
        <>
          {r.simulated && <Card className="border-warn p-3 text-xs text-warn">This was made on the sample feed, whose history is random, so the numbers mean nothing. Log in to Upstox and run it again.</Card>}
          <Card className="space-y-2 p-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <p className="text-muted">
                Last {r.period.days} trading days · {r.period.stocks} stocks · risk ₹{r.params.riskAmount} a trade · {sharesExitText(r.params)}
              </p>
              <button type="button" onClick={copy} className="btn btn-sm shrink-0">
                <ClipboardCopy className="h-3.5 w-3.5" /> Copy
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Net" value={formatPnl(o.totalNet)} tone={pnlClass(o.totalNet)} sub={`${o.trades} trades`} />
              <Stat label="Win rate" value={o.winRate == null ? '–' : `${o.winRate}%`} sub={`profit factor ${o.profitFactor ?? '–'}`} />
              <Stat label="Charges" value={formatPnl(-o.totalCharges)} tone="text-down" sub="already in the net" />
              <Stat label="Worst losing run" value={formatPnl(-o.maxDrawdown)} tone="text-down" />
            </div>
          </Card>
          <Group title="By setup" rows={r.bySetup} note="Switch a losing setup off in Account > Entries." />
          <ComboRows rows={r.combos} />
          <PairFinder pf={r.pairs} endpoint="/auto" callWord="Buys" putWord="Sells" />
          <AutoFound af={r.comboFound} endpoint="/auto" title="Combinations found" />
          <IndicatorRanking rows={r.indicators} skipped={r.combosSkipped} callWord="Buys" putWord="Sells" />
          <Group title="Buys and sells" rows={r.bySide} />
          <Group title="By hour of entry" rows={r.byHour} />
          <Group title="How the trades ended" rows={r.byExit} />
          <Card className="space-y-1 p-3">
            <h3 className="text-sm font-semibold">How far do ideas run?</h3>
            <p className="text-[11px] leading-snug text-muted">For each distance (in risks, 1R is the distance to the stop): the share of ideas that got that far before the stop, and the average result if every idea were sold there.</p>
            <table className="num w-full text-xs">
              <tbody className="divide-y divide-line">
                {r.firstTarget.map((t) => (
                  <tr key={t.target}>
                    <td className="py-1.5">{t.target}R</td>
                    <td>reached {t.hitRate ?? '–'}%</td>
                    <td className={pnlClass(t.expectancyR)}>
                      {t.expectancyR == null ? '–' : `${t.expectancyR > 0 ? '+' : ''}${t.expectancyR}R`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {r.recent.length > 0 && (
            <Card className="space-y-1 p-3">
              <h3 className="text-sm font-semibold">Latest trades</h3>
              <ul className="divide-y divide-line text-xs">
                {r.recent.map((t) => (
                  <li key={`${t.symbol}${t.openedAt}`} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 text-muted">
                      <b className="text-fg">{t.symbol}</b> {t.side === 'BUY' ? 'bought' : 'sold'} {istStamp(Date.parse(t.openedAt) / 1000)} · {t.setup} · ₹{formatPrice(t.entry)} → ₹{formatPrice(t.exitPrice)} · {t.exit}
                    </span>
                    <span className={`num shrink-0 font-semibold ${pnlClass(t.net)}`}>{formatPnl(t.net)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <p className="text-center text-[11px] leading-snug text-muted">{state.note}</p>
        </>
      )}
    </div>
  );
}
