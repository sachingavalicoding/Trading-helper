import { CONDITIONS, CONDITION_BY_KEY, usable } from '../combos/conditions.js';
import { MIN_TRADES } from '../combos/verdict.js';

// The pair finder: take one check (or the three best on their own) and try every other check next to it. Each pair is judged on two parts
// of the period, the older two thirds (where it is picked) and the newest third (which it never saw). Used by the options and shares studies,
// which differ only in how a list of checks is traded (`evaluateMany`).

export const PAIR_MIN_DAYS = 10;
export const PAIR_MIN_TRAIN = 10;
export const PAIR_MIN_TEST = 5;
const ANCHORS = 3; // how many of the best single checks are paired when none is chosen
const SHOW = 5; // partners kept per starting check

/** The checks to pair: the chosen one, or the best few that made money on their own with enough trades. */
export function pickAnchors(indicators, have, first) {
  if (first) {
    const c = CONDITION_BY_KEY.get(first);
    return c && usable(c, have) ? [c] : [];
  }
  return (indicators || [])
    .filter((r) => r.trades >= MIN_TRADES && r.net > 0 && CONDITION_BY_KEY.has(r.key) && usable(CONDITION_BY_KEY.get(r.key), have))
    .sort((a, b) => b.net - a.net)
    .slice(0, ANCHORS)
    .map((r) => CONDITION_BY_KEY.get(r.key));
}

/**
 * @param indicators  the single-check ranking of the same run (rows with key, trades, net)
 * @param have        what data the run had (see usable())
 * @param first       a check key to start from, or null for the best few
 * @param evaluateMany  async (list of check-key lists) => rows [{ conds, train, test, all }] in the same order; each of train/test/all is { trades, net, winRate }, all also has calls and puts { trades, net }
 */
export async function findPairs({ indicators, have, first = null, studyDays, trainEnd, evaluateMany }) {
  if (studyDays < PAIR_MIN_DAYS || trainEnd == null) return { skipped: `needs at least ${PAIR_MIN_DAYS} trading days, this run had ${studyDays}` };
  const anchors = pickAnchors(indicators, have, first);
  if (!anchors.length) return { skipped: first ? 'that check cannot be tested with the data this run had' : 'no single check made money on its own with enough trades, so choose one to start from' };
  const partners = CONDITIONS.filter((c) => usable(c, have) && c.needs !== 'news');
  const lists = [];
  const seen = new Set();
  const add = (conds) => {
    const key = [...conds].sort().join('+');
    if (!seen.has(key)) {
      seen.add(key);
      lists.push(conds);
    }
  };
  for (const a of anchors) {
    add([a.key]);
    for (const p of partners) if (p.key !== a.key) add([a.key, p.key]);
  }
  const rows = await evaluateMany(lists);
  const byKey = new Map(rows.map((r) => [[...r.conds].sort().join('+'), r]));
  const get = (conds) => byKey.get([...conds].sort().join('+'));
  const out = anchors.map((a) => {
    const base = get([a.key]);
    const found = partners
      .filter((p) => p.key !== a.key)
      .map((p) => get([a.key, p.key]))
      .filter((r) => r && r.train.trades >= PAIR_MIN_TRAIN && r.train.net > 0 && r.test.trades >= PAIR_MIN_TEST && r.test.net > 0)
      .sort((x, y) => y.test.net - x.test.net || y.train.net - x.train.net)
      .slice(0, SHOW)
      .map((r) => ({ conds: r.conds, labels: r.conds.map((k) => CONDITION_BY_KEY.get(k).label), trades: r.all.trades, winRate: r.all.winRate, net: r.all.net, calls: r.all.calls, puts: r.all.puts, train: r.train, test: r.test, lift: Math.round((r.all.net - base.all.net) * 100) / 100 }));
    return { key: a.key, label: a.label, group: a.group, trades: base.all.trades, winRate: base.all.winRate, net: base.all.net, train: base.train, test: base.test, found };
  });
  const trainDays = Math.floor((studyDays * 2) / 3);
  return { tried: lists.length, auto: !first, trainDays, testDays: studyDays - trainDays, minTrain: PAIR_MIN_TRAIN, minTest: PAIR_MIN_TEST, anchors: out };
}
