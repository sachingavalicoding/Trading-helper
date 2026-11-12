import { findCombos, findPairs, PAIR_MIN_DAYS, PAIR_MIN_TRAIN, PAIR_MIN_TEST } from '../study/pairFinder.js';
import { CONDITION_BY_KEY } from '../combos/conditions.js';

// The auto-learner's brain. It runs inside a finder run of the options or shares study (see `params.learn` there), so it reads the same saved
// candles, trades with the same live rules and pays the same charges. The days are split in two: the older two thirds, where a combination is
// picked, and the newest third, which the pick never saw. A pick is chosen only from what it did on the older days; the newest days are a
// pass-or-fail check on top, never a ranking, so a pick that looks good only because it was tuned to recent days is not let through.

export const LEARNER_SLOT = 'learner-pick'; // the id of the one combination the learner owns in the user's saved list
const CANDIDATES = 12; // the best found (by the older days) that get the side test and the check against the current set
const SHOWN = 6;
const sideWord = (side, kind) => (side ? (kind === 'shares' ? (side === 'CE' ? 'buys only' : 'sells only') : side === 'CE' ? 'calls only' : 'puts only') : kind === 'shares' ? 'buys and sells' : 'calls and puts');
const labelOf = (k) => CONDITION_BY_KEY.get(k)?.label ?? k;
const keyOf = (conds, side) => `${[...conds].sort().join('+')}|${side ?? ''}`;
const EMPTY = { trades: 0, net: 0, winRate: null };
const ZERO = { train: EMPTY, test: EMPTY, all: EMPTY };

/** The name the learner's combination is saved under. */
export function pickName(conds) {
  const name = `Learner: ${conds.map(labelOf).join(' + ')}`;
  return name.length > 60 ? `${name.slice(0, 57)}...` : name;
}

/** The learner's combination as it is saved: all its checks must hold, events count for 3 bars, one side or both. */
export function slotCombo({ conds, side = null }) {
  return { id: LEARNER_SLOT, name: pickName(conds), conds: [...conds], need: conds.length, window: 3, on: true, ...(side ? { side } : {}) };
}

/** Why a candidate is not used; an empty list means it passed every check. */
export function failures({ alone, withSet, baseline }) {
  const out = [];
  if (alone.train.trades < PAIR_MIN_TRAIN) out.push(`only ${alone.train.trades} trades on the older days (needs ${PAIR_MIN_TRAIN})`);
  else if (!(alone.train.net > 0)) out.push('lost money on the older days');
  if (alone.test.trades < PAIR_MIN_TEST) out.push(`only ${alone.test.trades} trades on the newest days (needs ${PAIR_MIN_TEST})`);
  else if (!(alone.test.net > 0)) out.push('lost money on the newest days it never saw');
  if (withSet && baseline && !(withSet.test.net > baseline.test.net)) out.push('did not add profit to your current combinations on the newest days');
  if (withSet && baseline && withSet.train.net < baseline.train.net) out.push('made your current combinations worse on the older days');
  return out;
}

/**
 * @param studyDays, trainEnd, indicators, have, evaluateMany  as the finders get them (see pairFinder.js)
 * @param evaluateSets  async (list of combination lists) => [{ train, test, all }] in the same order: each list traded together, one at a time, by the live rules
 * @param current   the switched-on saved combinations, without the learner's own
 * @param previous  the learner's saved combination (on or benched), or null
 * @param kind      'options' or 'shares' (only for the words)
 * @returns { verdict: 'found' | 'none' | 'short', text, pick?, baseline, candidates, tried, trainDays, testDays }
 */
export async function learn({ studyDays, trainEnd, indicators, have, evaluateMany, evaluateSets, current = [], previous = null, kind = 'options', onProgress = () => {} }) {
  const trainDays = Math.floor((studyDays * 2) / 3);
  const split = { trainDays, testDays: studyDays - trainDays };
  if (studyDays < PAIR_MIN_DAYS || trainEnd == null) return { verdict: 'short', text: `Not enough saved days to learn from: it needs at least ${PAIR_MIN_DAYS} trading days and found ${studyDays}. Nothing was changed.`, baseline: ZERO, candidates: [], tried: 0, ...split };
  onProgress('Learner: trying new combinations');
  const fresh = await findCombos({ indicators, have, studyDays, trainEnd, evaluateMany, show: 30 });
  const bases = current.slice(0, 6).map((c) => ({ id: c.id, name: c.name, conds: [...c.conds, ...(c.also || [])] }));
  onProgress('Learner: trying extra checks on your combinations');
  const added = bases.length ? await findPairs({ indicators, have, bases, depth: 2, show: 10, studyDays, trainEnd, evaluateMany }) : null;
  let tried = (fresh.tried ?? 0) + (added?.tried ?? 0);

  // every distinct list of checks found, best on the older days first; the learner's own pick always gets checked again
  const seen = new Map();
  for (const f of [...(fresh.found ?? []), ...(added?.anchors ?? []).flatMap((a) => a.found)]) {
    const k = keyOf(f.conds, null);
    if (!seen.has(k) || seen.get(k).train.net < f.train.net) seen.set(k, f);
  }
  const lists = [...seen.values()].sort((a, b) => b.train.net - a.train.net).slice(0, CANDIDATES).map((f) => f.conds);
  if (previous && !lists.some((c) => keyOf(c, null) === keyOf(previous.conds, null))) lists.push(previous.conds);

  onProgress('Learner: choosing a side for each');
  const sides = [null, 'CE', 'PE'];
  const variants = lists.flatMap((conds) => sides.map((side) => slotCombo({ conds, side })));
  const [baseline = ZERO, ...rows] = await evaluateSets([current, ...variants.map((v) => [v])]);
  tried += variants.length;
  // the side is chosen on the older days only
  const chosen = lists.map((conds, n) => {
    const three = sides.map((_, s) => ({ combo: variants[n * 3 + s], alone: rows[n * 3 + s] }));
    return three.reduce((best, x) => (x.alone.train.net > best.alone.train.net + 1e-9 ? x : best));
  });
  onProgress('Learner: checking each against your current combinations');
  const withRows = current.length ? await evaluateSets(chosen.map((c) => [...current, c.combo])) : chosen.map((c) => c.alone);
  const benched = previous && previous.on === false && previous.benchedOn ? keyOf(previous.conds, previous.side) : null;
  const judged = chosen.map((c, n) => {
    const withSet = withRows[n];
    const why = failures({ alone: c.alone, withSet, baseline });
    if (benched && keyOf(c.combo.conds, c.combo.side) === benched) why.push('switched off after live losses in a row, so not used again');
    const isPrevious = Boolean(previous && keyOf(c.combo.conds, null) === keyOf(previous.conds, null));
    return { name: c.combo.name, conds: c.combo.conds, labels: c.combo.conds.map(labelOf), side: c.combo.side ?? null, sideText: sideWord(c.combo.side, kind), train: c.alone.train, test: c.alone.test, all: c.alone.all, withSet: { train: withSet.train, test: withSet.test }, passed: !why.length, why, previous: isPrevious };
  });
  const passed = judged.filter((j) => j.passed).sort((a, b) => b.train.net - a.train.net);
  const pick = passed[0] ?? null;
  const candidates = [...judged].sort((a, b) => Number(b.passed) - Number(a.passed) || b.train.net - a.train.net).slice(0, SHOWN);
  const previousResult = judged.find((j) => j.previous) ?? null;
  if (!pick) {
    const text = lists.length
      ? `No edge found. ${lists.length} combinations made money on the older days, but none also made money on the newest ${split.testDays} days it never saw and beat your current combinations there, after charges. Nothing new is used.`
      : `No edge found. Nothing made money on both the older ${split.trainDays} days and the newest ${split.testDays} days after charges. Nothing new is used.`;
    return { verdict: 'none', text, baseline, candidates, previousResult, tried, ...split };
  }
  return { verdict: 'found', text: `Found: ${pick.labels.join(' + ')} (${pick.sideText}). Picked on the older ${split.trainDays} days, and it also made money on the newest ${split.testDays} days it never saw, more than your current combinations did there.`, pick, baseline, candidates, previousResult, tried, ...split };
}
