import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, X } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { formatPnl, formatPrice, pnlClass } from '../lib/format.js';
import { pctText } from '../lib/review.js';
import { timeAgo } from './NewsCard.jsx';
import { ReviewChart } from './ReviewChart.jsx';
import { Badge, Skeleton } from './ui.jsx';

const TIMING = { BEFORE_OPEN: 'Before the open', DURING: 'During the day', AFTER_CLOSE: 'After the close' };
const IDEA_STATUS = { TARGET_HIT: { text: 'Target hit', tone: 'up' }, STOPPED: { text: 'Stopped', tone: 'down' }, EXPIRED: { text: 'Expired', tone: 'muted' }, OPEN: { text: 'Open', tone: 'accent' } };

function Stat({ label, value, tone = '' }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

/** One stock on one day: the chart with the news and ideas marked on it, what each headline led to, and your trades. */
export function ReviewStockSheet({ symbol, day, onClose }) {
  const { data, loading, error } = useApi(`/review/stock/${encodeURIComponent(symbol)}?day=${day}`, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const marks = useMemo(() => {
    if (!data) return [];
    return [
      ...data.news.filter((n) => n.label !== 'NEUTRAL').map((n) => ({ at: n.publishedAt, text: 'News', kind: n.label === 'BULLISH' ? 'news-up' : 'news-down' })),
      ...data.ideas.map((i) => ({ at: i.raisedAt, text: `${i.side === 'BUY' ? 'Buy' : 'Sell'} idea`, kind: i.side === 'BUY' ? 'buy' : 'sell' })),
      ...data.trades.map((t) => ({ at: t.openedAt, text: 'You', kind: t.direction === 'LONG' ? 'buy' : 'sell' })),
    ];
  }, [data]);

  const m = data?.move;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label={`${symbol} on ${day}`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="sheet-in pb-safe relative max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface md:max-w-2xl md:rounded-2xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line md:hidden" />
        <div className="flex items-start justify-between px-4 pt-3">
          <div>
            <div className="text-lg font-bold">{symbol}</div>
            <div className="text-xs text-muted">
              {data?.name} · {day}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost -mr-2 !p-2">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          {loading && !data ? (
            <Skeleton className="h-64 w-full" />
          ) : error && !data ? (
            <p className="text-sm text-down">{error.message}</p>
          ) : (
            <>
              <ReviewChart candles={data.candles} open={m?.open} prevClose={m?.prevClose} marks={marks} />
              <dl className="grid grid-cols-3 gap-3 rounded-xl bg-surface-2 p-3">
                <Stat label="Open" value={formatPrice(m?.open)} />
                <Stat label="Close" value={formatPrice(m?.close)} />
                <Stat label="Open to close" value={pctText(m?.openToClosePct)} tone={pnlClass(m?.openToClosePct)} />
                <Stat label="Best (open to high)" value={pctText(m?.openToHighPct)} tone="text-up" />
                <Stat label="Dip (open to low)" value={pctText(m?.openToLowPct)} tone="text-down" />
                <Stat label="Gap at open" value={pctText(m?.gapPct)} tone={pnlClass(m?.gapPct)} />
              </dl>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">News and what the price did next</h3>
                {data.news.length === 0 ? (
                  <p className="text-sm text-muted">No headlines stored for this stock around this day.</p>
                ) : (
                  <ul className="divide-y divide-line rounded-xl border border-line">
                    {data.news.map((n) => (
                      <li key={n.id} className="space-y-1 px-3 py-2.5">
                        <a href={n.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 text-sm leading-snug">
                          <span className="min-w-0 flex-1">{n.title}</span>
                          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                        </a>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                          <Badge tone={n.label === 'BULLISH' ? 'up' : n.label === 'BEARISH' ? 'down' : 'muted'}>{n.label === 'BULLISH' ? 'Good' : n.label === 'BEARISH' ? 'Bad' : 'Neutral'}</Badge>
                          <span>
                            {n.source ? `${n.source} · ` : ''}
                            {TIMING[n.timing]}
                          </span>
                          {n.moveToClosePct != null && (
                            <span className={n.agreed === false ? 'font-semibold text-warn' : ''}>
                              · then {pctText(n.moveToClosePct)} to the close{n.agreed === true ? ' (price agreed)' : n.agreed === false ? ' (price went the other way)' : ''}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {data.ideas.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Scanner ideas</h3>
                  <ul className="divide-y divide-line rounded-xl border border-line">
                    {data.ideas.map((i) => (
                      <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm">
                        <div>
                          <div className="font-medium">
                            {i.side === 'BUY' ? 'Buy' : 'Sell'} · {i.setup}
                          </div>
                          <div className="num text-[11px] text-muted">
                            entry {formatPrice(i.entry)} · stop {formatPrice(i.stopLoss)} · score {i.score} · {timeAgo(i.raisedAt)}
                          </div>
                        </div>
                        <div className="text-right">
                          <Badge tone={IDEA_STATUS[i.status]?.tone}>{IDEA_STATUS[i.status]?.text}</Badge>
                          <div className="num mt-1 text-[11px] text-muted">
                            {i.status === 'OPEN' ? '' : `${i.resultR > 0 ? '+' : ''}${i.resultR}R`}
                            {i.bestR != null ? ` · ran ${i.bestR}R` : ''}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {data.trades.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Your trades</h3>
                  <ul className="divide-y divide-line rounded-xl border border-line">
                    {data.trades.map((t) => (
                      <li key={t.id} className="flex items-center justify-between px-3 py-2.5 text-sm">
                        <span>
                          {t.direction === 'LONG' ? 'Bought' : 'Sold short'} {t.qty} @ {formatPrice(t.avgPrice)}
                        </span>
                        <span className={`num font-semibold ${pnlClass(t.realizedPnl - t.charges)}`}>{t.status === 'OPEN' ? 'Open' : formatPnl(t.realizedPnl - t.charges)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <Link to={`/stock/${encodeURIComponent(symbol)}`} className="btn btn-secondary w-full">
                Live chart and depth
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
