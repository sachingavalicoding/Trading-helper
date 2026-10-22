import { useEffect } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { Card, Skeleton, Badge } from './ui.jsx';

const REFRESH_MS = 5 * 60_000;
const LABEL = { BULLISH: { text: 'Good news', tone: 'up' }, BEARISH: { text: 'Bad news', tone: 'down' } };

const REACTION = {
  BULLISH: { AGREES: 'Price is rising with it', FADING: 'Being sold: price fell after the news', FLAT: 'Price has not reacted yet' },
  BEARISH: { AGREES: 'Price is falling with it', FADING: 'Being bought: price rose after the news', FLAT: 'Price has not reacted yet' },
};

export function timeAgo(date) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** One line for a scanner idea: the headline that moved the score and whether the price agrees. */
export function NewsLine({ news }) {
  if (!news) return null;
  const good = news.label === 'BULLISH';
  const reaction = REACTION[news.label]?.[news.reaction];
  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${good ? 'bg-up-soft' : 'bg-down-soft'}`}>
      <Badge tone={good ? 'up' : 'down'}>{LABEL[news.label].text}</Badge> <span className="align-middle">{news.title}</span>
      {reaction && <div className="mt-0.5 text-[11px] text-muted">{reaction}</div>}
    </div>
  );
}

/** Headlines for one stock (or the whole market), tagged good / bad with a reaction check. */
export function NewsCard({ symbol = 'MARKET', title = 'News', limit = 6 }) {
  const { data, loading, error, reload } = useApi(`/news?symbol=${encodeURIComponent(symbol)}`, [symbol]);

  useEffect(() => {
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, [reload]);

  if (loading && !data) return <Skeleton className="h-28" />;
  if (error && !data) return <Card className="p-3 text-sm text-muted">News unavailable right now.</Card>;
  const items = data.items.slice(0, limit);

  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button type="button" onClick={reload} aria-label="Refresh news" className="-mr-1 rounded-lg p-1.5 text-muted hover:bg-surface-2">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted">No headlines in the last 2 days. Headlines load a few stocks at a time, so check again in a few minutes.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((n) => {
            const tag = LABEL[n.label];
            const reaction = REACTION[n.label]?.[n.reaction?.state];
            return (
              <li key={n.id} className="py-2 first:pt-0 last:pb-0">
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-sm leading-snug">{n.title}</span>
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-label="Opens the article" />
                </a>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                  {tag && <Badge tone={tag.tone}>{tag.text}</Badge>}
                  <span>
                    {n.source ? `${n.source} · ` : ''}
                    {timeAgo(n.publishedAt)}
                  </span>
                  {reaction && <span className={n.reaction.state === 'FADING' ? 'font-semibold text-warn' : ''}>· {reaction}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] leading-snug text-muted">{data.disclaimer}</p>
    </Card>
  );
}
