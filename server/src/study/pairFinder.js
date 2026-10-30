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

/** What `pairFirst` names: a saved combination (`combo:<id>`) to add checks to, or a single check; null for both when it is left out. */
export function pairStart(pairFirst, combos = []) {
  if (!pairFirst) return { first: null, base: null, missing: false };
  if (!pairFirst.startsWith('combo:')) return { first: pairFirst, base: null, missing: false };
  const c = combos.find((x) => `combo:${x.id}` === pairFirst);
  return { first: null, base: c ? { id: c.id, name: c.name, conds: c.conds } : null, missing: !c };
}

const asAnchor = (c) => ({ key: c.key, label: c.label, group: c.group, conds: [c.key] });

/** The things to add checks to: your saved combination, the chosen check, or the best few that made money on their own with enough trades. */
export function pickAnchors(indicators, have, first, base = null) {
  if (base) return base.conds.every((k) => CONDITION_BY_KEY.has(k) && usable(CONDITION_BY_KEY.get(k), have)) ? [{ key: `combo:${base.id}`, label: base.name, group: 'My combination', conds: base.conds }] : [];
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

/**
 * @param indicators  the single-check ranking of the same run (rows with key, trades, net)
 * @param have        what data the run had (see usable())
 * @param first       a check key to start from, or null for the best few
 * @param base        a saved combination { id, name, conds } to add one more check to (all its checks must hold), or null
 * @param evaluateMany  async (list of check-key lists) => rows [{ conds, train, test, all }] in the same order; each of train/test/all is { trades, net, winRate }, all also has calls and puts { trades, net }
 */
export async function findPairs({ indicators, have, first = null, base = null, studyDays, trainEnd, evaluateMany }) {
  if (studyDays < PAIR_MIN_DAYS || trainEnd == null) return { skipped: `needs at least ${PAIR_MIN_DAYS} trading days, this run had ${studyDays}` };
  const anchors = pickAnchors(indicators, have, first, base);
  if (!anchors.length) return { skipped: base ? 'that combination needs data this run did not have' : first ? 'that check cannot be tested with the data this run had' : 'no single check made money on its own with enough trades, so choose one to start from' };
  const partners = CONDITIONS.filter((c) => usable(c, have) && c.needs !== 'news');
  const lists = [];
  const seen = new Set();
  const add = (conds) => {
    if (!seen.has(keyOf(conds))) {
      seen.add(keyOf(conds));
      lists.push(conds);
    }
  };
  for (const a of anchors) {
    add(a.conds);
    for (const p of partners) if (!a.conds.includes(p.key)) add([...a.conds, p.key]);
  }
  const rows = await evaluateMany(lists);
  const byKey = new Map(rows.map((r) => [keyOf(r.conds), r]));
  const get = (conds) => byKey.get(keyOf(conds));
  const out = anchors.map((a) => {
    const alone = get(a.conds);
    const found = partners
      .filter((p) => !a.conds.includes(p.key))
      .map((p) => ({ p, r: get([...a.conds, p.key]) }))
      .filter((x) => worthShowing(x.r))
      .sort((x, y) => bestFirst(x.r, y.r))
      .slice(0, SHOW)
      .map(({ p, r }) => ({ ...shown(r, labelOf, Math.round((r.all.net - alone.all.net) * 100) / 100), added: p.label, addedKey: p.key, skipped: alone.all.trades - r.all.trades }));
    return { key: a.key, label: a.label, group: a.group, trades: alone.all.trades, winRate: alone.all.winRate, net: alone.all.net, train: alone.train, test: alone.test, found };
  });
  const trainDays = Math.floor((studyDays * 2) / 3);
  return { tried: lists.length, auto: !first && !base, addOn: Boolean(base), trainDays, testDays: studyDays - trainDays, minTrain: PAIR_MIN_TRAIN, minTest: PAIR_MIN_TEST, anchors: out };
}

const FINDER_POOL = 12; // the best single checks that are tried two and three at a time
const FINDER_SHOW = 8;

/**
 * The combination finder: takes the best single checks of the run and tries every pair and every triple of them, judged on the older two
 * thirds of the days and on the newest third it never saw. Only combinations that made money on both are shown.
 */
export async function findCombos({ indicators, have, studyDays, trainEnd, evaluateMany }) {
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
  const found = rows.filter(worthShowing).sort(bestFirst).slice(0, FINDER_SHOW).map((r) => shown(r, labelOf));
  const trainDays = Math.floor((studyDays * 2) / 3);
  return { tried: lists.length, pool: pool.map(labelOf), trainDays, testDays: studyDays - trainDays, minTrain: PAIR_MIN_TRAIN, minTest: PAIR_MIN_TEST, baselines: [], found };
}
