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
 * What stopped-out ideas did before they were stopped: how often they were in profit first,
 * and how long they lasted. Only ideas recorded after excursion tracking began carry `bestR`.
 */
function stoppedProfile(done) {
  const stopped = done.filter((i) => i.status === 'STOPPED' && i.bestR != null);
  if (!stopped.length) return { count: 0, reachedHalfR: null, reachedOneR: null, medianMinutes: null, avgBestR: null };
  const mins = stopped.filter((i) => i.closedAt && i.openedAt).map((i) => (new Date(i.closedAt) - new Date(i.openedAt)) / 60000).sort((a, b) => a - b);
  const share = (x) => round((stopped.filter((i) => i.bestR >= x).length / stopped.length) * 100, 0);
  return {
    count: stopped.length,
    reachedHalfR: share(0.5),
    reachedOneR: share(1),
    medianMinutes: mins.length ? round(mins[Math.floor(mins.length / 2)], 0) : null,
    avgBestR: round(stopped.reduce((a, i) => a + i.bestR, 0) / stopped.length),
  };
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
    stopped: stoppedProfile(done),
    bySetup: group(done, (i) => i.setup),
    bySide: group(done, (i) => i.side),
    byHour: group(done, hour, (h) => h).map((r) => ({ ...r, label: `${String(r.key).padStart(2, '0')}:00` })),
    byScore: group(done, (i) => (i.score >= 80 ? '80+' : i.score >= 70 ? '70-79' : '60-69'), (k) => ({ '80+': 0, '70-79': 1, '60-69': 2 })[k]),
  };
}
