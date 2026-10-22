import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellOff, ChevronDown, Radar, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useMarket } from '../context/MarketContext.jsx';
import { useApi } from '../lib/useApi.js';
import { useTick } from '../lib/tickStore.js';
import { formatPrice, formatPct, formatINR, formatTime, pnlClass } from '../lib/format.js';
import { OrderSheet } from '../components/OrderSheet.jsx';
import { MorningPlan } from '../components/MorningPlan.jsx';
import { alertsOn, alertsSupported, setAlerts } from '../lib/alerts.js';
import { NewsLine, NewsCard } from '../components/NewsCard.jsx';
import { Badge, Card, EmptyState, Segmented, Skeleton } from '../components/ui.jsx';

const REFRESH_MS = 30_000;
const RISK_OPTIONS = [
  { value: 0.5, label: '0.5%' },
  { value: 1, label: '1%' },
  { value: 2, label: '2%' },
];
const SIDE_OPTIONS = [
  { value: 'ALL', label: 'All' },
  { value: 'BUY', label: 'Buy' },
  { value: 'SELL', label: 'Sell' },
];
const OUTCOME = {
  TARGET_HIT: { label: 'Target hit', tone: 'up' },
  STOPPED: { label: 'Stopped out', tone: 'down' },
  EXPIRED: { label: 'Expired', tone: 'muted' },
};

function loadRisk() {
  try {
    const v = Number(localStorage.getItem('scanner.risk'));
    return RISK_OPTIONS.some((o) => o.value === v) ? v : 1;
  } catch {
    return 1;
  }
}

const ago = (iso) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
};

function Cell({ label, children, note }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="num text-sm font-bold">{children}</div>
      {note && <div className="text-[11px] leading-tight text-muted">{note}</div>}
    </div>
  );
}

/** One idea: what to do, where to enter, where to get out, how many shares, and why. */
function IdeaCard({ idea, onBuy }) {
  const tick = useTick(idea.symbol);
  const [why, setWhy] = useState(false);
  const isBuy = idea.side === 'BUY';
  const ltp = tick?.ltp ?? idea.ltp;
  const changePct = tick?.changePct ?? idea.changePct;
  const entering = idea.status === 'ENTRY';
  const risk = Math.abs(idea.entry - idea.stopLoss);
  const movedR = entering && risk ? ((isBuy ? 1 : -1) * (ltp - idea.entry)) / risk : null;
  const sideWord = isBuy ? 'above' : 'below';

  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/stock/${encodeURIComponent(idea.symbol)}`} className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">{idea.symbol}</span>
            <Badge tone={isBuy ? 'up' : 'down'}>{idea.side}</Badge>
          </div>
          <div className="text-xs text-muted">
            {idea.setup} · score {idea.score}/100{entering && idea.openedAt ? ` · ${ago(idea.openedAt)}` : ''}
          </div>
        </Link>
        <div className="text-right">
          <div className="num text-lg font-bold">₹{formatPrice(ltp)}</div>
          <div className={`num text-xs ${pnlClass(changePct)}`}>{formatPct(changePct)}</div>
        </div>
      </div>

      {idea.status === 'WATCHING' && (
        <div className="rounded-lg bg-accent/10 px-3 py-2 text-sm">
          <span className="font-semibold">Watching.</span> Enter only if price trades {sideWord} <span className="num font-semibold">₹{formatPrice(idea.trigger)}</span>.
        </div>
      )}
      {idea.status === 'MISSED' && (
        <div className="rounded-lg bg-warn/15 px-3 py-2 text-sm">
          <span className="font-semibold">Missed.</span> Price already ran past the entry zone. Do not chase it.
        </div>
      )}
      {entering && movedR != null && (
        <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <span className="font-semibold text-accent">Entry now</span>
          <span className={`num font-semibold ${pnlClass(movedR)}`}>
            {movedR > 0 ? '+' : ''}
            {movedR.toFixed(2)}R since the idea
          </span>
        </div>
      )}

      <NewsLine news={idea.news} />

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-surface-2 p-3">
        <Cell label="Entry zone">
          {formatPrice(idea.entryLow)} – {formatPrice(idea.entryHigh)}
        </Cell>
        <Cell label="Reward : risk">{idea.riskReward} : 1</Cell>
        <Cell label="Stop loss" note={idea.stopNote}>
          <span className="text-down">{formatPrice(idea.stopLoss)}</span>
        </Cell>
        <Cell label="Target 1 / Target 2" note={idea.targetNote}>
          <span className="text-up">
            {formatPrice(idea.target1)} / {formatPrice(idea.target2)}
          </span>
        </Cell>
      </div>

      <div className="flex items-center justify-between gap-3 text-sm">
        <div>
          <span className="num font-bold">{idea.size.qty} shares</span> <span className="text-muted">risks {formatINR(idea.size.riskUsed)}</span>
          {idea.size.note && <div className="text-[11px] text-muted">{idea.size.note}</div>}
        </div>
      </div>

      {entering && (
        <button
          type="button"
          disabled={idea.size.qty < 1}
          onClick={() => onBuy(idea)}
          className={`w-full rounded-xl py-3 text-base font-bold text-white disabled:opacity-40 ${isBuy ? 'bg-up' : 'bg-down'}`}
        >
          {isBuy ? 'Buy' : 'Sell'} {idea.size.qty} with stop loss and target 1
        </button>
      )}

      <button type="button" onClick={() => setWhy((w) => !w)} aria-expanded={why} className="flex w-full items-center justify-between text-sm font-semibold text-accent">
        Why?
        <ChevronDown className={`h-4 w-4 transition-transform ${why ? 'rotate-180' : ''}`} />
      </button>
      {why && (
        <div className="space-y-3 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            {idea.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase text-muted">Score</div>
            <ul className="space-y-1">
              {idea.checks.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-3 text-xs">
                  <span>
                    <span className="font-medium">{c.label}:</span> <span className="text-muted">{c.text}</span>
                  </span>
                  <span className={`num shrink-0 font-semibold ${c.points ? 'text-up' : 'text-muted'}`}>
                    {c.points}/{c.max}
                  </span>
                </li>
              ))}
              {idea.penalties?.map((p) => (
                <li key={p} className="text-xs text-down">
                  {p}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase text-muted">This idea is wrong if</div>
            <p className="text-xs">{idea.wrongIf}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

function Section({ title, hint, children }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export default function Scanner() {
  const [risk, setRisk] = useState(loadRisk);
  const [side, setSide] = useState('ALL');
  const [alerts, setAlertsState] = useState(alertsOn);
  async function toggleAlerts() {
    const on = await setAlerts(!alerts);
    setAlertsState(on);
    if (!alerts && !on) toast.error('Notifications are blocked for this site. Allow them in your browser settings.');
    else toast(on ? 'Alerts on. You get a phone notification when this tab is in the background.' : 'Alerts off');
  }
  const [sheet, setSheet] = useState(null);
  const { instruments } = useMarket();
  const { data, loading, error, reload } = useApi(`/scanner?risk=${risk}`, [risk]);

  useEffect(() => {
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, [reload]);

  const pickRisk = (v) => {
    setRisk(v);
    try {
      localStorage.setItem('scanner.risk', String(v));
    } catch {
      /* private mode: the choice just is not remembered */
    }
  };

  const items = useMemo(() => (data?.items || []).filter((i) => side === 'ALL' || i.side === side), [data, side]);
  const entries = items.filter((i) => i.status === 'ENTRY');
  const watching = items.filter((i) => i.status !== 'ENTRY');
  const done = (data?.done || []).filter((d) => side === 'ALL' || d.side === side);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Stocks in play</h1>
          <p className="text-xs text-muted">
            {data?.updatedAt ? `Updated ${formatTime(data.updatedAt)} IST · ${data.scanned} of ${data.total} Nifty 50 stocks scanned` : 'Nifty 50 intraday ideas'}
          </p>
        </div>
        <div className="flex items-center">
          {alertsSupported() && (
            <button type="button" onClick={toggleAlerts} aria-pressed={alerts} aria-label={alerts ? 'Turn phone alerts off' : 'Turn phone alerts on'} className={`rounded-lg p-2 hover:bg-surface-2 ${alerts ? 'text-accent' : 'text-muted'}`}>
              {alerts ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
            </button>
          )}
          <button type="button" onClick={reload} aria-label="Refresh" className="rounded-lg p-2 text-muted hover:bg-surface-2">
            <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <MorningPlan />

      <Card className="space-y-3 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Risk per trade</div>
            <div className="num text-xs text-muted">{data ? `₹${Math.round((data.capital * risk) / 100).toLocaleString('en-IN')} lost if stopped out` : ' '}</div>
          </div>
          <Segmented size="sm" options={RISK_OPTIONS} value={risk} onChange={pickRisk} />
        </div>
        <Segmented size="sm" options={SIDE_OPTIONS} value={side} onChange={setSide} className="w-full" />
      </Card>

      {loading && !data && (
        <div className="space-y-3">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      )}
      {error && !data && (
        <Card className="p-4 text-sm text-muted">
          The scanner is unavailable right now.{' '}
          <button type="button" onClick={reload} className="font-semibold text-accent">
            Try again
          </button>
        </Card>
      )}

      {data?.warming && (
        <Card className="p-3 text-sm text-muted">
          Loading price history: {data.loaded} of {data.total} stocks. Ideas appear once it finishes.
        </Card>
      )}

      {data && !data.warming && (
        <>
          <Section title="Entry now" hint={entries.length ? `${entries.length} idea${entries.length > 1 ? 's' : ''}` : null}>
            {entries.length === 0 ? (
              <Card>
                <EmptyState icon={Radar} title="No good setups right now">
                  That is normal. Only ideas that score 60 or more and pay at least 1.5 times the risk are shown. Staying out is a valid trade.
                </EmptyState>
              </Card>
            ) : (
              entries.map((i) => <IdeaCard key={i.ideaId || `${i.symbol}-${i.setup}`} idea={i} onBuy={setSheet} />)
            )}
          </Section>

          {watching.length > 0 && (
            <Section title="Watching" hint="setup forming, no entry yet">
              {watching.map((i) => (
                <IdeaCard key={`${i.symbol}-${i.setup}-${i.side}`} idea={i} onBuy={setSheet} />
              ))}
            </Section>
          )}

          {done.length > 0 && (
            <Section title="Done today">
              <Card className="divide-y divide-line">
                {done.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <Link to={`/stock/${encodeURIComponent(d.symbol)}`} className="font-semibold">
                        {d.symbol}
                      </Link>{' '}
                      <span className={d.side === 'BUY' ? 'text-up' : 'text-down'}>{d.side}</span>
                      <div className="truncate text-[11px] text-muted">
                        {d.setup} · {d.closedAt ? formatTime(d.closedAt) : ''}
                      </div>
                    </div>
                    <Badge tone={OUTCOME[d.status]?.tone}>{OUTCOME[d.status]?.label || d.status}</Badge>
                  </div>
                ))}
              </Card>
            </Section>
          )}
        </>
      )}

      <NewsCard symbol="MARKET" title="Market headlines" limit={5} />

      {data?.disclaimer && <p className="text-center text-[11px] text-muted">{data.disclaimer}</p>}

      {sheet && (
        <OrderSheet
          symbol={sheet.symbol}
          name={instruments?.stocks.find((x) => x.symbol === sheet.symbol)?.name}
          side={sheet.side}
          qty={sheet.size.qty}
          plan={{ stopLoss: sheet.stopLoss, target: sheet.target1 }}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}
