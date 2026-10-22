import { istParts } from '../market/marketHours.js';

const MIN_SAMPLE = 20; // below this a hit rate says almost nothing
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Profit or loss in units of the planned risk: +1 means it made as much as it risked. */
export function resultR(idea) {
  const risk = Math.abs(idea.entry - idea.stopLoss);
  if (!risk || idea.exitPrice == null) return null;
  const d = idea.side === 'BUY' ? 1 : -1;
  return (d * (idea.exitPrice - idea.entry)) / risk;
}

function bucket(ideas) {
  const rs = ideas.map(resultR).filter((r) => r != null);
  const wins = ideas.filter((i) => i.status === 'TARGET_HIT').length;
  const stops = ideas.filter((i) => i.status === 'STOPPED').length;
  const expired = ideas.length - wins - stops;
  return {
    count: ideas.length,
    wins,
    stops,
    expired,
    winRate: ideas.length ? round((wins / ideas.length) * 100, 0) : null,
    avgR: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    totalR: rs.length ? round(rs.reduce((a, b) => a + b, 0)) : null,
    enough: ideas.length >= MIN_SAMPLE,
  };
}

function group(ideas, keyOf, order) {
  const map = new Map();
  for (const i of ideas) map.set(keyOf(i), [...(map.get(keyOf(i)) || []), i]);
  const rows = [...map].map(([key, list]) => ({ key, ...bucket(list) }));
  return order ? rows.sort((a, b) => order(a.key) - order(b.key)) : rows.sort((a, b) => b.count - a.count);
}

/**
 * Track record of finished ideas (status not OPEN). `openedAt` is when the idea was raised.
 * Hit rate alone misleads, so every row also shows average R (result per unit of risk).
 */
export function summarizeIdeas(ideas) {
  const done = ideas.filter((i) => i.status && i.status !== 'OPEN');
  const hour = (i) => Math.floor(istParts(new Date(i.openedAt)).minutes / 60);
  return {
    minSample: MIN_SAMPLE,
    overall: bucket(done),
    bySetup: group(done, (i) => i.setup),
    bySide: group(done, (i) => i.side),
    byHour: group(done, hour, (h) => h).map((r) => ({ ...r, label: `${String(r.key).padStart(2, '0')}:00` })),
    byScore: group(done, (i) => (i.score >= 80 ? '80+' : i.score >= 70 ? '70-79' : '60-69'), (k) => ({ '80+': 0, '70-79': 1, '60-69': 2 })[k]),
  };
}
