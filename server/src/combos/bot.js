// @ts-check
// "Bot-calculated stop and targets" for one options combination. When its switch is on, the combination's trades do not use the normal
// profit ladder: they sell a part at each of (at least) three targets, and the stop moves up after each one: to the entry (plus charges)
// after the first, to the first target after the second, and the third sells what is left. All amounts are rupees for ONE LOT, so they
// fit a trade of any size. The levels come from the combination's own trades over its last 30 days (calcBot below); the switch off
// means the normal ladder works as before. Nothing is changed by the bot itself: it suggests, you Apply (and can Undo).

export const DEFAULT_PARTS = [33, 33, 34]; // percent of the lots sold at each target (equal thirds)
export const MIN_TARGETS = 3;
export const MAX_TARGETS = 5;
export const STOP_LIMITS = [200, 20_000]; // rupees per lot
export const MIN_FIRST = 300; // the first target is never closer than this (charges are about ₹60-100 a lot for the round trip)
export const MIN_GAP = 150; // rupees between two targets
export const MIN_CALC_TRADES = 8; // fewer trades than this in the days used: no levels are suggested
export const REACHED = [0.7, 0.5, 0.3]; // targets: the profit reached by 7, 5 and 3 trades in 10
/** The target sets the bot tries on the days it learns from (closer and further than REACHED); the best of them there is suggested. */
export const REACH_SETS = [[0.8, 0.6, 0.4], REACHED, [0.6, 0.4, 0.2]];
export const WINNER_DIP = 0.9; // stop: 9 in 10 winners never went further down than it

const round50 = (/** @type {number} */ x) => Math.round(x / 50) * 50;
const up50 = (/** @type {number} */ x) => Math.ceil(x / 50) * 50;

/** A percentile (0 to 1) of a list, or null for an empty one. */
export function pct(/** @type {number[]} */ list, /** @type {number} */ p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/**
 * @typedef {{ at: number, part: number }} BotTarget
 * @typedef {{ on: boolean, stop: number, targets: BotTarget[], setAt?: string, info?: any, prev?: any }} Bot
 */

/** Clean the parts so they are whole percents from 1 and add up to 100 (the last one takes the rounding). */
function cleanParts(/** @type {number[]} */ parts) {
  const raw = parts.map((p) => Math.max(1, Math.round(Number(p) || 0)));
  const sum = raw.reduce((s, p) => s + p, 0);
  const out = raw.map((p) => Math.max(1, Math.round((p / sum) * 100)));
  out[out.length - 1] = Math.max(1, 100 - out.slice(0, -1).reduce((s, p) => s + p, 0));
  return out;
}

/** The levels part of a bot (stop and targets), cleaned, or null when they cannot be used. */
export function normalizeLevels(/** @type {any} */ raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stop = Math.round(Number(raw.stop));
  if (!(stop >= STOP_LIMITS[0] && stop <= STOP_LIMITS[1])) return null;
  if (!Array.isArray(raw.targets) || raw.targets.length < MIN_TARGETS || raw.targets.length > MAX_TARGETS) return null;
  const ats = raw.targets.map((/** @type {any} */ t) => Math.round(Number(t?.at)));
  if (!ats.every((/** @type {number} */ a, /** @type {number} */ i) => a > 0 && a <= 100_000 && (i === 0 || a > ats[i - 1]))) return null;
  const parts = cleanParts(raw.targets.map((/** @type {any} */ t) => t?.part));
  return { stop, targets: ats.map((/** @type {number} */ at, /** @type {number} */ i) => ({ at, part: parts[i] })) };
}

/** A combination's saved bot (switch, levels, when and how they were set, what Undo puts back), or undefined. */
export function normalizeBot(/** @type {any} */ raw) {
  const levels = normalizeLevels(raw);
  if (!levels) return undefined;
  /** @type {Bot} */
  const out = { on: raw.on === true, ...levels };
  if (typeof raw.setAt === 'string' && raw.setAt.length <= 40) out.setAt = raw.setAt;
  if (raw.info && typeof raw.info === 'object' && JSON.stringify(raw.info).length <= 4000) out.info = raw.info;
  if (raw.prev === null) out.prev = null;
  else if (raw.prev && typeof raw.prev === 'object') {
    const prev = normalizeLevels(raw.prev);
    if (prev) out.prev = { ...prev, on: raw.prev.on === true, ...(typeof raw.prev.setAt === 'string' && raw.prev.setAt.length <= 40 ? { setAt: raw.prev.setAt } : {}) };
  }
  return out;
}

/** The bot a combination's trades use now: its levels when the switch is on, otherwise null (the normal ladder). */
export function activeBot(/** @type {any} */ combo) {
  const b = normalizeBot(combo?.bot);
  return b?.on ? { stop: b.stop, targets: b.targets } : null;
}

/**
 * How many lots are sold at each target, for a trade of `lots`: the parts are counted up and rounded, and the last target sells
 * everything left. Equal thirds: 3 lots [1, 1, 1], 2 lots [1, 0, 1], 1 lot [0, 1, 0] (the lot is sold at the middle target and the
 * first one only moves the stop up to the entry).
 */
export function allot(/** @type {number} */ lots, /** @type {BotTarget[]} */ targets) {
  let cum = 0;
  let given = 0;
  return targets.map((t, i) => {
    cum += t.part;
    const upTo = i === targets.length - 1 ? lots : Math.min(lots, Math.round((lots * cum) / 100));
    const n = Math.max(0, upTo - given);
    given += n;
    return n;
  });
}

/**
 * The stop (rupees a lot below the entry, negative) after `hit` targets: the bot stop before the first, the entry plus `charges`
 * (rupees a lot for the round trip) after the first, then the target before the last one hit.
 */
export function stopAfter(/** @type {{ stop: number, targets: BotTarget[] }} */ bot, /** @type {number} */ hit, /** @type {number} */ charges = 0) {
  if (hit <= 0) return -bot.stop;
  if (hit === 1) return Math.max(0, Math.round(charges));
  return bot.targets[hit - 2].at;
}

/**
 * The stop and targets for one combination from its own trades over the days used, all in rupees for one lot. Each trade is
 * `{ best, worst, net, lots }`, where best and worst are how far it went up and down (whole trade) with no profit lock.
 * Targets: the profit 7, 5 and 3 trades in 10 reached at some point (round to ₹50, the first at least ₹300, ₹150 apart).
 * Stop: 9 in 10 winners never went further down than it (rounded up to ₹50), never more than `cap` (the loss cut for one lot).
 * @param {{ best: number, worst: number, net: number, lots?: number }[]} trades
 * @param {{ cap?: number, parts?: number[], reach?: number[] }} [o]  reach: the share of trades each target must have been reached by
 */
export function calcBot(trades, { cap = 2000, parts = DEFAULT_PARTS, reach = REACHED } = {}) {
  const per = trades
    .filter((t) => Number.isFinite(t.best) && Number.isFinite(t.worst) && Number.isFinite(t.net))
    .map((t) => {
      const lots = Math.max(1, t.lots ?? 1);
      return { best: t.best / lots, worst: t.worst / lots, net: t.net / lots };
    });
  if (per.length < MIN_CALC_TRADES) return { skipped: `Only ${per.length} trade${per.length === 1 ? '' : 's'} in the days used; at least ${MIN_CALC_TRADES} are needed to set levels.`, trades: per.length };
  const bests = per.map((t) => t.best);
  const ats = [];
  for (const p of reach) {
    const raw = /** @type {number} */ (pct(bests, 1 - p));
    const floor = ats.length ? ats[ats.length - 1] + MIN_GAP : MIN_FIRST;
    ats.push(Math.max(floor, round50(raw)));
  }
  const wins = per.filter((t) => t.net > 0);
  const capLot = Math.max(STOP_LIMITS[0], Math.min(STOP_LIMITS[1], Math.round(cap)));
  const dip = wins.length >= 3 ? pct(wins.map((t) => -t.worst), WINNER_DIP) : null;
  const stop = dip == null ? capLot : Math.min(capLot, Math.max(STOP_LIMITS[0], up50(/** @type {number} */ (dip) + 1)));
  const share = cleanParts(parts.length === ats.length ? parts : DEFAULT_PARTS);
  const reached = ats.map((at) => per.filter((t) => t.best >= at).length);
  const stoppedOut = per.filter((t) => t.worst <= -stop).length;
  return {
    stop,
    targets: ats.map((at, i) => ({ at, part: share[i] })),
    basis: { reach, trades: per.length, wins: wins.length, reached, stoppedOut, winnerDip: dip == null ? null : Math.round(dip), halfRanUp: Math.round(/** @type {number} */ (pct(bests, 0.5))) },
  };
}

const rs = (/** @type {number} */ x) => `₹${Math.round(x).toLocaleString('en-IN')}`;

/** The levels in words: "stop -₹900 · sell 33% at +₹700, 33% at +₹1,200, 34% at +₹1,700 (a lot)". */
export function botText(/** @type {{ stop: number, targets: BotTarget[] } | null | undefined} */ b) {
  if (!b) return 'normal ladder';
  return `stop -${rs(b.stop)} · sell ${b.targets.map((t) => `${t.part}% at +${rs(t.at)}`).join(', ')} (a lot)`;
}
