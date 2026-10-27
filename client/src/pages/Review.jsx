import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { formatPnl, formatPrice, pnlClass } from '../lib/format.js';
import { VERDICT, pctText, shiftDay, takeaways } from '../lib/review.js';
import { ReviewChart } from '../components/ReviewChart.jsx';
import { ReviewStockSheet } from '../components/ReviewStockSheet.jsx';
import { Badge, Card, EmptyState, Segmented, Skeleton } from '../components/ui.jsx';

const TABS = [
  { value: 'stocks', label: 'Stocks' },
  { value: 'options', label: 'Options' },
  { value: 'techniques', label: 'Techniques' },
];

const istToday = () => new Date(Date.now() + 19800_000).toISOString().slice(0, 10);

function Tile({ label, value, sub, tone = '' }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num text-xl font-bold ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </Card>
  );
}

function Verdict({ result }) {
  if (!result) return <span className="text-muted">—</span>;
  const v = VERDICT[result.verdict];
  return <Badge tone={v.tone}>{v.text}</Badge>;
}

const SIDE_TEXT = { BUY: 'Buy', SELL: 'Sell' };
const callOf = (row) =>
  row.news
    ? { text: row.news.label === 'BULLISH' ? 'Good news' : 'Bad news', sub: row.news.source || row.news.category, result: row.news.result }
    : { text: `${SIDE_TEXT[row.ideas[0].side]} idea`, sub: row.ideas[0].setup, result: row.ideas[0].result };

function StocksTab({ day, onPick }) {
  const { data, loading, error } = useApi(`/review/day?day=${day}`, []);
  if (loading && !data) return <Skeleton className="h-72 w-full" />;
  if (error && !data) return <EmptyState title="Could not load this day">{error.message}</EmptyState>;
  const { summary, stocks } = data;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Tile label="News calls" value={summary.news.calls ? `${summary.news.hitRate ?? '—'}%` : '—'} sub={summary.news.calls ? `${summary.news.hits} hit · ${summary.news.misses} miss · ${summary.news.flat} flat` : 'No morning headlines'} tone={summary.news.hitRate >= 50 ? 'text-up' : summary.news.calls ? 'text-down' : ''} />
        <Tile label="Avg move after a call" value={summary.news.calls ? pctText(summary.news.avgEdgePct) : '—'} sub={summary.news.calls ? `best ${pctText(summary.news.avgBestPct)} · dip ${pctText(summary.news.avgDipPct)}` : 'Open to close, in its direction'} tone={pnlClass(summary.news.avgEdgePct)} />
        <Tile label="Scanner ideas" value={summary.ideas.calls || '—'} sub={summary.ideas.finished ? `${summary.ideas.targets} target · ${summary.ideas.stopped} stopped · avg ${summary.ideas.avgR}R` : 'None finished'} />
        <Tile label="Best call" value={summary.bestCall ? summary.bestCall.symbol : '—'} sub={summary.bestCall ? pctText(summary.bestCall.edgePct) : ''} tone="text-up" />
      </div>
      {summary.worstCall && (
        <p className="text-center text-xs text-muted">
          Worst call: <b className="text-fg">{summary.worstCall.symbol}</b> <span className="text-down">{pctText(summary.worstCall.edgePct)}</span>
        </p>
      )}

      <Card className="overflow-hidden">
        {stocks.length === 0 ? (
          <EmptyState title="No calls on this day">Nothing was tagged in the morning news and the scanner raised no ideas.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-20 bg-surface">
                    Stock and call
                  </th>
                  <th scope="col">Day</th>
                  <th scope="col">High</th>
                  <th scope="col">Dip</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((r) => {
                  const call = callOf(r);
                  return (
                    <tr key={r.symbol} tabIndex={0} onClick={() => onPick(r.symbol)} onKeyDown={(e) => e.key === 'Enter' && onPick(r.symbol)} aria-label={`${r.symbol}, tap for the day`}>
                      <td className="sticky left-0 z-10 bg-surface">
                        <div className="text-sm font-semibold">{r.symbol}</div>
                        <div className="max-w-[6rem] truncate text-[11px] text-muted">
                          {call.text} · {call.sub}
                        </div>
                      </td>
                      <td className={`num font-semibold ${pnlClass(r.move?.openToClosePct)}`}>{pctText(r.move?.openToClosePct)}</td>
                      <td className="num text-up">{pctText(r.move?.openToHighPct)}</td>
                      <td className="num text-down">{pctText(r.move?.openToLowPct)}</td>
                      <td>
                        <Verdict result={call.result} />
                        {r.news && r.ideas.length > 0 && <div className="mt-0.5 text-[10px] text-muted">idea: {r.ideas[0].status === 'TARGET_HIT' ? 'target' : r.ideas[0].status === 'STOPPED' ? 'stopped' : r.ideas[0].status.toLowerCase()}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-center text-[11px] leading-snug text-muted">
        A news call is the net tag of headlines out before the 09:15 open, judged from the open to the close. Day is open to close. Hit: it ended that way by 0.15% or more. High and Dip: how far it went for and against the call from the open. Tap a stock for its chart.
      </p>
    </div>
  );
}

function ImpactRow({ title, impact }) {
  return (
    <Card className="p-3">
      <div className="text-xs font-semibold">{title}</div>
      <div className="num mt-1 flex items-baseline justify-between">
        <span className={`text-xl font-bold ${pnlClass(impact.closePct)}`}>{pctText(impact.closePct)}</span>
        <span className="text-[11px] text-muted">
          best <b className="text-up">{pctText(impact.bestPct)}</b> · dip <b className="text-down">{pctText(impact.dipPct)}</b>
        </span>
      </div>
    </Card>
  );
}

function OptionsTab({ day }) {
  const { data, loading, error } = useApi(`/review/day?day=${day}`, []);
  const { data: chart } = useApi(`/review/stock/NIFTY%2050?day=${day}`, []);
  if (loading && !data) return <Skeleton className="h-72 w-full" />;
  if (error && !data) return <EmptyState title="Could not load this day">{error.message}</EmptyState>;
  const { nifty, options } = data;
  if (!nifty) return <EmptyState title="No Nifty 50 data for this day">It may be a holiday, or older than the broker history.</EmptyState>;
  const m = nifty.move;
  return (
    <div className="space-y-3">
      <Card className="space-y-2 p-3">
        <div className="flex items-baseline justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-accent2">Nifty 50 on {day}</div>
          <div className={`num text-sm font-bold ${pnlClass(m.openToClosePct)}`}>{pctText(m.openToClosePct)}</div>
        </div>
        <ReviewChart candles={chart?.candles} open={m.open} prevClose={m.prevClose} marks={[]} />
        <dl className="num grid grid-cols-4 gap-2 text-center text-xs">
          {[
            ['Open', formatPrice(m.open)],
            ['High', formatPrice(m.high)],
            ['Low', formatPrice(m.low)],
            ['Close', formatPrice(m.close)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-muted">{k}</dt>
              <dd className="font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="grid gap-2 md:grid-cols-2">
        <ImpactRow title="A Call (CE) bought at the open: the index moved" impact={nifty.ifCallAtOpen} />
        <ImpactRow title="A Put (PE) bought at the open: the index moved" impact={nifty.ifPutAtOpen} />
      </div>
      <p className="text-[11px] leading-snug text-muted">These are index moves, not option prices. An option gains or loses several times more in %, and time decay works against a buyer, so a small index move can still lose money.</p>

      <h2 className="pt-1 text-sm font-semibold">Your option decisions</h2>
      <Card className="overflow-hidden">
        {options.entries.length === 0 ? (
          <EmptyState title="No option decisions on this day">The option trader logs every buy and every skip.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {options.entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {e.type === 'CE' ? 'Call' : e.type === 'PE' ? 'Put' : 'Option'}
                    <Badge tone={e.decision === 'PLACED' ? 'accent' : 'muted'}>{e.decision === 'PLACED' ? (e.manual ? 'By hand' : 'Bought') : 'Skipped'}</Badge>
                    {e.niftyAgreed && <Badge tone={VERDICT[e.niftyAgreed].tone}>Nifty {VERDICT[e.niftyAgreed].text.toLowerCase()}</Badge>}
                  </div>
                  <div className="truncate text-[11px] text-muted">{e.decision === 'PLACED' ? `score ${e.score ?? '—'}${e.outcome?.exitReason ? ` · exit ${e.outcome.exitReason.toLowerCase().replace('_', ' ')}` : ''}` : e.reason}</div>
                </div>
                {e.outcome?.netPnl != null && <span className={`num font-semibold ${pnlClass(e.outcome.netPnl)}`}>{formatPnl(e.outcome.netPnl)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {options.summary.closed > 0 && (
        <p className="text-center text-xs text-muted">
          {options.summary.closed} closed · {options.summary.wins} won · net <b className={pnlClass(options.summary.netPnl)}>{formatPnl(options.summary.netPnl)}</b>
        </p>
      )}
    </div>
  );
}

function Table({ head, rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="grid-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_tr]:cursor-default">{rows}</tbody>
      </table>
    </div>
  );
}

const rTone = (r) => (r == null ? '' : r > 0 ? 'text-up' : r < 0 ? 'text-down' : '');
const rText = (r) => (r == null ? '—' : `${r > 0 ? '+' : ''}${r}R`);

function TechniquesTab() {
  const [days, setDays] = useState(30);
  const { data, loading, error } = useApi(`/review/techniques?days=${days}`, []);
  const lines = useMemo(() => takeaways(data), [data]);
  if (loading && !data) return <Skeleton className="h-72 w-full" />;
  if (error && !data) return <EmptyState title="Could not load the report">{error.message}</EmptyState>;
  const { scanner, trades, news } = data;
  return (
    <div className="space-y-4">
      <Segmented className="w-full" size="sm" value={days} onChange={setDays} options={[{ value: 14, label: '14 days' }, { value: 30, label: '30 days' }, { value: 60, label: '60 days' }]} />

      <Card className="space-y-2 border-accent2/40 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-accent2">
          <Lightbulb className="h-4 w-4" /> What the numbers say
        </h2>
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-snug">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="text-[11px] text-muted">
          {scanner.overall.count} finished scanner ideas since {data.since}. Under about 20 per row is too few to trust.
        </p>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Technique families (scanner ideas, in risk units)</h2>
        <Card className="overflow-hidden">
          <Table
            head={['Family', 'Ideas', 'Hit target 1', 'Avg R', 'Total R']}
            rows={scanner.byFamily.map((f) => (
              <tr key={f.key}>
                <td className="font-semibold">{f.key}</td>
                <td className="num">{f.count}</td>
                <td className="num">{f.winRate}%</td>
                <td className={`num ${rTone(f.avgR)}`}>{rText(f.avgR)}</td>
                <td className={`num font-semibold ${rTone(f.totalR)}`}>{rText(f.totalR)}</td>
              </tr>
            ))}
          />
        </Card>
        <Card className="overflow-hidden">
          <Table
            head={['Setup', 'Ideas', 'Hit', 'Stopped', 'Avg R']}
            rows={scanner.bySetup.map((s) => (
              <tr key={s.key}>
                <td>
                  <div className="font-semibold">{s.key}</div>
                  <div className="text-[11px] text-muted">{s.family}</div>
                </td>
                <td className="num">{s.count}</td>
                <td className="num">{s.wins}</td>
                <td className="num">{s.stops}</td>
                <td className={`num font-semibold ${rTone(s.avgR)}`}>{rText(s.avgR)}</td>
              </tr>
            ))}
          />
        </Card>
      </section>

      {scanner.byCheck.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Which chart checks helped (RSI, VWAP, volume ...)</h2>
          <Card className="overflow-hidden">
            <Table
              head={['Check', 'With it', 'Without', 'Lift']}
              rows={scanner.byCheck.map((c) => (
                <tr key={c.id}>
                  <td className="font-semibold">{c.label}</td>
                  <td className={`num ${rTone(c.withAvgR)}`}>
                    {rText(c.withAvgR)} <span className="text-muted">({c.withCount})</span>
                  </td>
                  <td className={`num ${rTone(c.withoutAvgR)}`}>
                    {rText(c.withoutAvgR)} <span className="text-muted">({c.withoutCount})</span>
                  </td>
                  <td className={`num font-semibold ${rTone(c.liftR)}`}>{rText(c.liftR)}</td>
                </tr>
              ))}
            />
          </Card>
          <p className="text-[11px] text-muted">Average result of ideas where the check earned at least half its points, against ideas where it did not. Lift is the difference.</p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">How stocks followed each kind of news</h2>
        <Card className="overflow-hidden">
          {news.byCategory.length === 0 ? (
            <EmptyState title="No finished news calls yet">Needs headlines from before an open and that day's close.</EmptyState>
          ) : (
            <Table
              head={['News', 'Calls', 'Followed', 'Open to close', 'Best', 'Dip']}
              rows={news.byCategory.map((c) => (
                <tr key={c.key}>
                  <td className="font-semibold">{c.key.toLowerCase().replace('_', ' ')}</td>
                  <td className="num">{c.calls}</td>
                  <td className="num">{c.hitRate == null ? '—' : `${c.hitRate}%`}</td>
                  <td className={`num font-semibold ${pnlClass(c.avgEdgePct)}`}>{pctText(c.avgEdgePct)}</td>
                  <td className="num text-up">{pctText(c.avgBestPct)}</td>
                  <td className="num text-down">{pctText(c.avgDipPct)}</td>
                </tr>
              ))}
            />
          )}
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Your paper trades</h2>
        <Card className="overflow-hidden">
          {trades.equity.closed === 0 && trades.options.closed === 0 ? (
            <EmptyState title="No closed auto trades in this period" />
          ) : (
            <>
              {trades.equity.bySetup.length > 0 && (
                <Table
                  head={['Shares by setup', 'Trades', 'Won', 'Net', 'Avg R']}
                  rows={trades.equity.bySetup.map((s) => (
                    <tr key={s.key}>
                      <td className="font-semibold">{s.key}</td>
                      <td className="num">{s.trades}</td>
                      <td className="num">{s.wins}</td>
                      <td className={`num font-semibold ${pnlClass(s.netPnl)}`}>{formatPnl(s.netPnl)}</td>
                      <td className={`num ${rTone(s.avgR)}`}>{rText(s.avgR)}</td>
                    </tr>
                  ))}
                />
              )}
              {trades.equity.byExit.length > 0 && (
                <Table
                  head={['Shares by exit', 'Trades', 'Won', 'Net', 'Avg R']}
                  rows={trades.equity.byExit.map((s) => (
                    <tr key={s.key}>
                      <td className="font-semibold">{String(s.key).toLowerCase().replace('_', ' ')}</td>
                      <td className="num">{s.trades}</td>
                      <td className="num">{s.wins}</td>
                      <td className={`num font-semibold ${pnlClass(s.netPnl)}`}>{formatPnl(s.netPnl)}</td>
                      <td className={`num ${rTone(s.avgR)}`}>{rText(s.avgR)}</td>
                    </tr>
                  ))}
                />
              )}
              {trades.options.byType.length > 0 && (
                <Table
                  head={['Options', 'Trades', 'Won', 'Net']}
                  rows={trades.options.byType.map((s) => (
                    <tr key={s.key}>
                      <td className="font-semibold">{s.key === 'CE' ? 'Calls (CE)' : s.key === 'PE' ? 'Puts (PE)' : s.key}</td>
                      <td className="num">{s.trades}</td>
                      <td className="num">{s.wins}</td>
                      <td className={`num font-semibold ${pnlClass(s.netPnl)}`}>{formatPnl(s.netPnl)}</td>
                    </tr>
                  ))}
                />
              )}
            </>
          )}
        </Card>
      </section>

      {scanner.byHour.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">By hour the idea was raised</h2>
          <Card className="overflow-hidden">
            <Table
              head={['Hour', 'Ideas', 'Hit', 'Avg R']}
              rows={scanner.byHour.map((h) => (
                <tr key={h.key}>
                  <td className="font-semibold">{h.label}</td>
                  <td className="num">{h.count}</td>
                  <td className="num">{h.winRate}%</td>
                  <td className={`num font-semibold ${rTone(h.avgR)}`}>{rText(h.avgR)}</td>
                </tr>
              ))}
            />
          </Card>
        </section>
      )}
      <p className="text-center text-[11px] leading-snug text-muted">{data.disclaimer}</p>
    </div>
  );
}

/** Look back at the calls: what the morning news and the scanner said against what each stock did, and which techniques paid. */
export default function Review() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState('stocks');
  const today = istToday();
  const [day, setDay] = useState(params.get('day') || today);
  const [pick, setPick] = useState(params.get('symbol')?.toUpperCase() || null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-bold">
          Calls <span className="text-accent2">vs results</span>
        </h1>
        <Link to="/news" className="btn btn-secondary btn-sm">
          News
        </Link>
      </div>
      <Segmented className="w-full" value={tab} onChange={setTab} options={TABS} />

      {tab !== 'techniques' && (
        <div className="flex items-center justify-between gap-2">
          <button type="button" aria-label="Previous day" onClick={() => setDay((d) => shiftDay(d, -1))} className="btn btn-secondary !p-2">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} className="field num !w-auto text-center !text-sm" aria-label="Day to review" />
          <button type="button" aria-label="Next day" disabled={day >= today} onClick={() => setDay((d) => shiftDay(d, 1))} className="btn btn-secondary !p-2">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {tab === 'stocks' && <StocksTab day={day} onPick={setPick} />}
      {tab === 'options' && <OptionsTab day={day} />}
      {tab === 'techniques' && <TechniquesTab />}

      {pick && <ReviewStockSheet symbol={pick} day={day} onClose={() => setPick(null)} />}
    </div>
  );
}
