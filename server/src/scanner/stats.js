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

// ---- "What wins" in the track record (day report), added 11 Nov 2026 ----

const ratioOf = (idea, id) => {
  const c = idea.card?.checks?.find((k) => k.id === id);
  return c && c.max > 0 ? c.points / c.max : null;
};

/** Stop distance in % of the entry. */
export const stopBand = (i) => {
  const p = (Math.abs(i.entry - i.stopLoss) / i.entry) * 100;
  return p < 0.4 ? 'under 0.4%' : p < 0.5 ? '0.4-0.5%' : p < 0.8 ? '0.5-0.8%' : '0.8% or more';
};

/** The share against Nifty 50 when the idea was raised: the saved reading, else what the score's "Vs Nifty 50" part earned. */
export const vsNiftyBand = (i) => {
  const d = i.side === 'BUY' ? 1 : -1;
  const rs = i.card?.facts?.relStrength;
  if (rs != null) return d * rs >= 0.5 ? '0.5%+ stronger' : d * rs >= 0.2 ? '0.2-0.5% stronger' : d * rs >= 0 ? '0-0.2% stronger' : 'weaker than Nifty';
  const r = ratioOf(i, 'strength');
  if (r == null) return null;
  return r >= 0.99 ? '0.5%+ stronger' : r >= 0.5 ? '0.2-0.5% stronger' : r > 0 ? '0-0.2% stronger' : 'weaker than Nifty';
};

/** Volume against normal for the time of day. */
export const volumeBand = (i) => {
  const v = i.card?.facts?.relVol;
  if (v != null) return v >= 2 ? '2x+' : v >= 1.5 ? '1.5-2x' : v >= 1.2 ? '1.2-1.5x' : 'under 1.2x';
  const r = ratioOf(i, 'volume');
  if (r == null) return null;
  return r >= 0.99 ? '2x+' : r >= 0.6 ? '1.5-2x' : r > 0 ? '1.2-1.5x' : 'under 1.2x';
};

/** Was the market with the trade? Nifty's trend when saved (from 11 Nov), else whether most of the 50 shares moved the same way (the score's "Market" part). */
export const marketBand = (i) => {
  const d = i.side === 'BUY' ? 1 : -1;
  const t = i.card?.facts?.niftyTrend;
  if (t != null) return d * t > 0 ? 'Nifty trending with it' : t === 0 ? 'Nifty sideways' : 'Nifty trending against it';
  const r = ratioOf(i, 'niftyTrend');
  if (r == null) return null;
  return r > 0 ? 'most shares moving with it' : 'most shares not moving with it';
};

/** Average result if every idea had been sold at +k risks once it got there (the rest as they ended). Needs bestR. */
function soldAt(ideas, k) {
  const rated = ideas.filter((i) => i.bestR != null && resultR(i) != null);
  if (!rated.length) return null;
  const rs = rated.map((i) => (i.bestR >= k ? k : resultR(i)));
  return { count: rated.length, avgR: round(rs.reduce((a, b) => a + b, 0) / rs.length) };
}

/**
 * The finished ideas split by what was true when they were raised, so the losing kinds stand out. `chargesR(idea)` (optional)
 * is the round-trip charges of the trade the idea would make, in risk units, so the break-even line can be shown.
 */
export function whatWins(ideas, { chargesR = null } = {}) {
  const done = ideas.filter((i) => i.status && i.status !== 'OPEN');
  const by = (keyOf) => group(done.filter((i) => keyOf(i) != null), keyOf).sort((a, b) => (b.avgR ?? -9) - (a.avgR ?? -9));
  const stopped = done.filter((i) => i.status === 'STOPPED' && i.bestR != null);
  const charges = chargesR ? done.map(chargesR).filter((x) => x != null && Number.isFinite(x)) : [];
  return {
    count: done.length,
    byStop: by(stopBand),
    byMarket: by(marketBand),
    byVsNifty: by(vsNiftyBand),
    byVolume: by(volumeBand),
    bySide: by((i) => i.side),
    byHour: group(done, (i) => `${String(Math.floor(istParts(new Date(i.openedAt)).minutes / 60)).padStart(2, '0')}:00`, (k) => Number(k.slice(0, 2))),
    quickFails: stopped.length ? { stopped: stopped.length, neverHalfR: stopped.filter((i) => i.bestR < 0.2).length } : null,
    soldAtHalfR: soldAt(done, 0.5),
    soldAtOneR: soldAt(done, 1),
    asIs: soldAt(done, Infinity),
    chargesR: charges.length ? round(charges.reduce((a, b) => a + b, 0) / charges.length) : null,
  };
}
