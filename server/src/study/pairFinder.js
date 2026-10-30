import { CONDITIONS, CONDITION_BY_KEY, usable } from '../combos/conditions.js';
import { MIN_TRADES } from '../combos/verdict.js';

// The pair finder: take one check (or the three best on their own, or one of your saved combinations) and try every other check next to it. Each pair is judged on two parts
// of the period, the older two thirds (where it is picked) and the newest third (which it never saw). Used by the options and shares studies,
// which differ only in how a list of checks is traded (`evaluateMany`).

export const PAIR_MIN_DAYS = 10;
export const PAIR_MIN_TRAIN = 10;
export const PAIR_MIN_TEST = 5;
const ANCHORS = 3; // how many of the best single checks are paired when none is chosen
const SHOW = 5; // partners kept per starting check

const MAX_BASES = 6; // "all my combinations" starts from at most this many of the switched-on ones

/** What `pairFirst` names: a saved combination (`combo:<id>`) to add checks to, all the switched-on ones (`combo:*`), or a single check; none of those when it is left out. */
export function pairStart(pairFirst, combos = []) {
  if (!pairFirst) return { first: null, bases: [], missing: false };
  if (!pairFirst.startsWith('combo:')) return { first: pairFirst, bases: [], missing: false };
  const pick = pairFirst === 'combo:*' ? combos.filter((c) => c.on !== false).slice(0, MAX_BASES) : combos.filter((x) => `combo:${x.id}` === pairFirst);
  return { first: null, bases: pick.map((c) => ({ id: c.id, name: c.name, conds: c.conds })), missing: !pick.length };
}

const asAnchor = (c) => ({ key: c.key, label: c.label, group: c.group, conds: [c.key] });
const asBase = (b) => ({ key: `combo:${b.id}`, label: b.name, group: 'My combination', conds: b.conds });

/** The things to add checks to: your saved combinations, the chosen check, or the best few that made money on their own with enough trades. */
export function pickAnchors(indicators, have, first, bases = []) {
  if (bases.length) return bases.filter((b) => b.conds.every((k) => CONDITION_BY_KEY.has(k) && usable(CONDITION_BY_KEY.get(k), have))).map(asBase);
  if (first) {
    const c = CONDITION_BY_KEY.get(first);
    return c && usable(c, have) ? [asAnchor(c)] : [];
  }
  return (indicators || [])
    .filter((r) => r.trades >= MIN_TRADES && r.net > 0 && CONDITION_BY_KEY.has(r.key) && usable(CONDITION_BY_KEY.get(r.key), have))
    .sort((a, b) => b.net - a.net)
    .slice(0, ANCHORS)
    .map((r) => asAnchor(CONDITION_BY_KEY.get(r.key)));
}

const shown = (r, labelOf, lift = null) => ({ conds: r.conds, labels: r.conds.map(labelOf), trades: r.all.trades, winRate: r.all.winRate, net: r.all.net, calls: r.all.calls, puts: r.all.puts, train: r.train, test: r.test, ...(lift == null ? {} : { lift }) });
const labelOf = (k) => CONDITION_BY_KEY.get(k).label;
const keyOf = (conds) => [...conds].sort().join('+');
const worthShowing = (r) => r && r.train.trades >= PAIR_MIN_TRAIN && r.train.net > 0 && r.test.trades >= PAIR_MIN_TEST && r.test.net > 0;
const bestFirst = (x, y) => y.test.net - x.test.net || y.train.net - x.train.net;

const DEEP_POOL = 8; // the best extra checks (by the older days) that are tried two at a time
const DEEP_TRIPLES = 6; // and the best of those three at a time
const SHOW_DEEP = 10; // results kept per starting point when going deeper

/** How the results are ordered: by profit on the newer days, or by win rate (then profit). */
export const GOALS = ['profit', 'winrate'];
const order = (goal) => (goal === 'winrate' ? (x, y) => (y.all.winRate ?? 0) - (x.all.winRate ?? 0) || y.test.net - x.test.net : bestFirst);

/** What adding checks to `alone` removed: its trades that are not in `r` (compared by entry time), how many lost and what they came to. Null when the rows carry no trade lists. */
function skippedOf(alone, r) {
  if (!alone.list || !r.list) return null;
  const kept = new Set(r.list.map(([t]) => t));
  const gone = alone.list.filter(([t]) => !kept.has(t));
  const losers = gone.filter(([, n]) => n <= 0);
  const sum = (xs) => Math.round(xs.reduce((a, [, n]) => a + n, 0) * 100) / 100;
  return { trades: gone.length, losers: losers.length, losersNet: sum(losers), winners: gone.length - losers.length, winnersNet: sum(gone.filter(([, n]) => n > 0)) };
}

/**
 * @param indicators  the single-check ranking of the same run (rows with key, trades, net)
 * @param have        what data the run had (see usable())
 * @param first       a check key to start from, or null for the best few
 * @param bases       saved combinations { id, name, conds } to add checks to (all of a combination's checks must hold)
 * @param depth       1 = one extra check, 2 = also the best two at a time, 3 = also the best three at a time
 * @param show        results kept per starting point
 * @param goal        'profit' (newer-days profit) or 'winrate'
 * @param evaluateMany  async (list of check-key lists) => rows [{ conds, train, test, all }] in the same order; each of train/test/all is { trades, net, winRate }, all also has calls and puts { trades, net }
 */
export async function findPairs({ indicators, have, first = null, bases = [], depth = 1, show = null, goal = 'profit', studyDays, trainEnd, evaluateMany }) {
  if (studyDays < PAIR_MIN_DAYS || trainEnd == null) return { skipped: `needs at least ${PAIR_MIN_DAYS} trading days, this run had ${studyDays}` };
  const anchors = pickAnchors(indicators, have, first, bases);
  if (!anchors.length) return { skipped: bases.length ? 'that combination needs data this run did not have' : first ? 'that check cannot be tested with the data this run had' : 'no single check made money on its own with enough trades, so choose one to start from' };
  const deep = depth >= 2;
  const partners = CONDITIONS.filter((c) => usable(c, have) && c.needs !== 'news');
  const byKey = new Map();
  let tried = 0;
  const evaluateNew = async (lists) => {
    const fresh = [];
    const seen = new Set();
    for (const conds of lists) {
      const k = keyOf(conds);
      if (!byKey.has(k) && !seen.has(k)) {
        seen.add(k);
        fresh.push(conds);
      }
    }
    if (!fresh.length) return;
    const rows = await evaluateMany(fresh);
    tried += rows.length;
    for (const r of rows) byKey.set(keyOf(r.conds), r);
  };
  const get = (conds) => byKey.get(keyOf(conds));
  // level 1: every other check added to each starting point (all start points in one pass)
  await evaluateNew(anchors.flatMap((a) => [a.conds, ...partners.filter((p) => !a.conds.includes(p.key)).map((p) => [...a.conds, p.key])]));
  const top = (a, n) =>
    partners
      .filter((p) => !a.conds.includes(p.key))
      .map((p) => ({ p, r: get([...a.conds, p.key]) }))
      .filter((x) => x.r && x.r.train.trades >= PAIR_MIN_TRAIN && x.r.train.net > get(a.conds).train.net)
      .sort((x, y) => y.r.train.net - x.r.train.net)
      .slice(0, n)
      .map((x) => x.p.key);
  const pools = new Map(anchors.map((a) => [a.key, top(a, DEEP_POOL)]));
  if (deep) {
    // level 2: the best extra checks two at a time
    const twos = (a) => pools.get(a.key).flatMap((x, i) => pools.get(a.key).slice(i + 1).map((y) => [...a.conds, x, y]));
    await evaluateNew(anchors.flatMap(twos));
    // level 3: the best of those, three at a time
    if (depth >= 3) {
      const threes = (a) => {
        const best = pools.get(a.key).slice(0, DEEP_TRIPLES);
        return best.flatMap((x, i) => best.slice(i + 1).flatMap((y, j) => best.slice(i + j + 2).map((z) => [...a.conds, x, y, z])));
      };
      await evaluateNew(anchors.flatMap(threes));
    }
  }
  const out = anchors.map((a) => {
    const alone = get(a.conds);
    const extra = (conds) => conds.filter((k) => !a.conds.includes(k));
    const candidates = [...byKey.values()].filter((r) => r.conds.length > a.conds.length && a.conds.every((k) => r.conds.includes(k)));
    const found = candidates
      .filter((r) => worthShowing(r) && (goal === 'winrate' ? (r.all.winRate ?? 0) > (alone.all.winRate ?? 0) : r.all.net > alone.all.net))
      .sort(order(goal))
      .slice(0, show ?? (deep ? SHOW_DEEP : SHOW))
      .map((r) => {
        const added = extra(r.conds);
        return { ...shown(r, labelOf, Math.round((r.all.net - alone.all.net) * 100) / 100), added: added.map(labelOf), addedKeys: added, depth: added.length, skipped: alone.all.trades - r.all.trades, skips: skippedOf(alone, r), winRateLift: r.all.winRate == null || alone.all.winRate == null ? null : Math.round((r.all.winRate - alone.all.winRate) * 10) / 10 };
      });
    return { key: a.key, label: a.label, group: a.group, conds: a.conds, trades: alone.all.trades, winRate: alone.all.winRate, net: alone.all.net, calls: alone.all.calls, puts: alone.all.puts, train: alone.train, test: alone.test, found };
  });
  const trainDays = Math.floor((studyDays * 2) / 3);
  return { tried, auto: !first && !bases.length, addOn: bases.length > 0, deep, depth, goal, trainDays, testDays: studyDays - trainDays, minTrain: PAIR_MIN_TRAIN, minTest: PAIR_MIN_TEST, anchors: out };
}

const FINDER_POOL = 12; // the best single checks that are tried two and three at a time
const FINDER_SHOW = 8;

/**
 * The combination finder: takes the best single checks of the run and tries every pair and every triple of them, judged on the older two
 * thirds of the days and on the newest third it never saw. Only combinations that made money on both are shown.
 */
export async function findCombos({ indicators, have, studyDays, trainEnd, evaluateMany, show = FINDER_SHOW, goal = 'profit' }) {
  if (studyDays < PAIR_MIN_DAYS || trainEnd == null) return { skipped: `needs at least ${PAIR_MIN_DAYS} trading days, this run had ${studyDays}` };
  const pool = (indicators || [])
    .filter((r) => r.trades >= MIN_TRADES && r.net > 0 && CONDITION_BY_KEY.has(r.key) && usable(CONDITION_BY_KEY.get(r.key), have) && CONDITION_BY_KEY.get(r.key).needs !== 'news')
    .sort((a, b) => b.net - a.net)
    .slice(0, FINDER_POOL)
    .map((r) => r.key);
  if (pool.length < 3) return { skipped: 'fewer than three single checks made money with enough trades, so there is nothing to combine' };
  const lists = [];
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    lists.push([pool[i], pool[j]]);
    for (let k = j + 1; k < pool.length; k++) lists.push([pool[i], pool[j], pool[k]]);
  }
  const rows = await evaluateMany(lists);
  const found = rows.filter(worthShowing).sort(order(goal)).slice(0, show).map((r) => shown(r, labelOf));
  const trainDays = Math.floor((studyDays * 2) / 3);
  return { tried: lists.length, pool: pool.map(labelOf), trainDays, testDays: studyDays - trainDays, minTrain: PAIR_MIN_TRAIN, minTest: PAIR_MIN_TEST, baselines: [], found };
}
