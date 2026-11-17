// @ts-check
// Learn > Each combination: finds the best settings for one combination on its own: calls, puts or both, one or two extra indicators
// (yesterday's levels included), its own profit ladder (small targets such as "at +₹750 keep ₹700" too), its own loss cut in rupees,
// its own trail and break-even. Ladder and cut sizes also come from the combination's own trades: how far its winners usually went
// against it before winning (a cut beyond that rarely costs a winner) and how far its trades usually ran up (a ladder that starts there).
// As in tune.js the newest days are hidden while it learns; a change must also help through most of the learning days (not one lucky
// day), and the old and new settings are then replayed on the hidden days. This file only decides; the replay is passed in.

import { splitDays, steady, judge, consistent, marginOf, roomLadder, FILTERS, TRAILS, MIN_LEARN_TRADES, MIN_HIDDEN_TRADES } from './tune.js';

/**
 * @typedef {import('./tune.js').Settings} Settings
 * @typedef {import('./tune.js').Combo} Combo
 * @typedef {{ entryTime: number, net: number, best?: number, worst?: number }} Trade
 * @typedef {{ key: string, group: string, label: string, from: string, to: string, apply: (c: Combo) => Combo }} Move
 */

export const MAX_COMBO_CHANGES = 3; // more than this on one combination and it is mostly fitted to the past
export const COMBO_ROUNDS = 3;
export const CUTS = [750, 1000, 1500, 2000, 2500];
/** @type {[number, number][]} */
export const LADDER_STARTS = [[750, 50], [1000, 100], [1000, 250], [1500, 300], [2000, 500], [3000, 750]];
export const BREAK_EVENS = [0, 20, 40];
export const EXCURSION_STEPS = [500, 750, 1000, 1500, 2000, 2500, 3000];

const r2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;
const rs = (/** @type {number} */ x) => `${x < 0 ? '-' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
const round50 = (/** @type {number} */ x) => Math.round(x / 50) * 50;
const sideWords = (/** @type {string|undefined} */ side) => (side === 'CE' ? 'calls only' : side === 'PE' ? 'puts only' : 'calls and puts');
export const ladderText = (/** @type {{ at: number, keep: number }[] | undefined} */ steps) => (steps === undefined ? 'shared ladder' : steps.length ? `at +${rs(steps[0].at)} keep ${rs(steps[0].keep)}, then every ₹500` : 'no profit lock');
export const cutText = (/** @type {number | undefined} */ cut) => (cut ? `sell at ${rs(-cut)}` : 'no own loss cut');
const trailText = (/** @type {any} */ t) => (t === undefined ? 'shared trail' : t ? `trail ${t.points} points once ${t.start} up` : 'no trail');
const beText = (/** @type {number | undefined} */ b) => (b === undefined ? 'shared break-even' : b ? `stop to entry after ${b} points` : 'no break-even');

/** A percentile (0 to 1) of a list, or null for an empty one. */
export function pct(/** @type {number[]} */ list, /** @type {number} */ p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/**
 * What the combination's own trades say about its stop and its ladder (rupees, one trade as sized live).
 * For each loss level: how many trades went that far down, and how many of those still ended in profit ("came back").
 * @param {Trade[]} trades
 */
export function excursions(trades) {
  const withPath = trades.filter((t) => Number.isFinite(t.worst) && Number.isFinite(t.best));
  const wins = withPath.filter((t) => t.net > 0);
  const losses = withPath.filter((t) => t.net <= 0);
  const down = EXCURSION_STEPS.map((x) => {
    const hit = withPath.filter((t) => /** @type {number} */ (t.worst) <= -x);
    return { at: x, trades: hit.length, cameBack: hit.filter((t) => t.net > 0).length };
  });
  const up = EXCURSION_STEPS.map((x) => {
    const hit = withPath.filter((t) => /** @type {number} */ (t.best) >= x);
    return { at: x, trades: hit.length, endedLoss: hit.filter((t) => t.net <= 0).length };
  });
  const winnersDip = pct(wins.map((t) => -(/** @type {number} */ (t.worst))), 0.9); // 9 in 10 winners never went further down than this
  const runUp = pct(withPath.map((t) => /** @type {number} */ (t.best)), 0.5); // half the trades ran up at least this far
  const losersRanUp = losses.filter((t) => /** @type {number} */ (t.best) >= 500).length;
  return { trades: withPath.length, wins: wins.length, down, up, winnersDip: winnersDip == null ? null : r2(winnersDip), runUp: runUp == null ? null : r2(runUp), losersRanUp };
}

/** The sentences a person reads about those excursions: where the trades never came back from, and where winners turned into losers. */
export function excursionNotes(/** @type {ReturnType<typeof excursions>} */ ex) {
  const notes = [];
  const never = ex.down.filter((d) => d.trades >= 2 && d.cameBack === 0);
  if (never.length) notes.push(`Every trade that went ${rs(-never[0].at)} or lower ended as a loss (${never[0].trades} trade${never[0].trades === 1 ? '' : 's'}): a cut near there costs no winner.`);
  if (ex.winnersDip != null && ex.wins >= 3) notes.push(`9 in 10 winners never went lower than ${rs(-ex.winnersDip)} on the way.`);
  const turned = ex.up.filter((u) => u.trades >= 2 && u.endedLoss > 0).at(-1);
  if (turned) notes.push(`${turned.endedLoss} of ${turned.trades} trades that were ${rs(turned.at)} up still ended in a loss: a lock at about that level would have kept them.`);
  if (ex.runUp != null && ex.trades >= 4) notes.push(`Half the trades ran up ${rs(ex.runUp)} or more at some point.`);
  return notes;
}

/** Puts a combination's own exits part in place (`undefined` removes it, so the shared one is used). */
function withExit(/** @type {Combo} */ c, /** @type {string} */ part, /** @type {any} */ value) {
  const exits = { ...(c.exits ?? {}) };
  if (value === undefined) delete exits[part];
  else exits[part] = value;
  const out = { ...c };
  if (Object.keys(exits).length) out.exits = exits;
  else delete out.exits;
  return out;
}

/**
 * Every single change worth trying on one combination. Ladder and cut sizes include ones taken from its own trades (`ex`).
 * @param {Combo} c
 * @param {{ labelOf: (k: string) => string, usable: (k: string) => boolean, ex?: ReturnType<typeof excursions> | null, previous?: Combo | null }} o
 * @returns {Move[]}
 */
export function comboMoves(c, { labelOf, usable, ex = null, previous = null }) {
  /** @type {Move[]} */
  const out = [];
  const e = c.exits ?? {};
  for (const side of [undefined, 'CE', 'PE']) {
    if ((c.side ?? undefined) === side) continue;
    out.push({ key: 'side', group: 'Side', label: sideWords(side), from: sideWords(c.side), to: sideWords(side), apply: (x) => { const { side: _drop, ...rest } = x; return side ? { ...rest, side } : rest; } });
  }
  const have = new Set([...c.conds, ...(c.also ?? [])]);
  if ((c.also ?? []).length < 2) {
    for (const k of FILTERS) {
      if (have.has(k) || !usable(k)) continue;
      out.push({ key: `also:${k}`, group: 'Extra indicator', label: `add ${labelOf(k)}`, from: '–', to: labelOf(k), apply: (x) => ({ ...x, also: [...(x.also ?? []), k] }) });
    }
  }
  for (const k of c.also ?? []) out.push({ key: `also:${k}`, group: 'Extra indicator', label: `take away ${labelOf(k)}`, from: labelOf(k), to: '–', apply: (x) => ({ ...x, also: (x.also ?? []).filter((z) => z !== k) }) });

  /** @type {[number, number][]} */
  const starts = [...LADDER_STARTS];
  if (ex?.runUp && ex.runUp >= 400) {
    const start = round50(ex.runUp * 0.8); // a little under where half the trades got to, so most of them lock something
    starts.push([start, Math.max(50, round50(start * 0.15))]);
  }
  const seen = new Set();
  for (const [start, gap] of starts) {
    const steps = roomLadder(start, gap);
    const key = JSON.stringify(steps);
    if (seen.has(key) || JSON.stringify(e.steps) === key) continue;
    seen.add(key);
    out.push({ key: 'steps', group: 'Profit ladder', label: `profit ladder ${ladderText(steps)}`, from: ladderText(e.steps), to: ladderText(steps), apply: (x) => withExit(x, 'steps', steps) });
  }
  if (e.steps?.length !== 0) out.push({ key: 'steps', group: 'Profit ladder', label: 'no profit lock', from: ladderText(e.steps), to: 'no profit lock', apply: (x) => withExit(x, 'steps', []) });

  const cuts = new Set(CUTS);
  if (ex?.winnersDip && ex.winnersDip >= 300) cuts.add(Math.ceil((ex.winnersDip + 100) / 100) * 100); // just beyond where its winners went
  const never = ex?.down.find((d) => d.trades >= 2 && d.cameBack === 0);
  if (never) cuts.add(never.at);
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (e.cut === cut) continue;
    out.push({ key: 'cut', group: 'Loss cut', label: `own loss cut: ${cutText(cut)}`, from: cutText(e.cut), to: cutText(cut), apply: (x) => withExit(x, 'cut', cut) });
  }
  if (e.cut) out.push({ key: 'cut', group: 'Loss cut', label: 'no own loss cut', from: cutText(e.cut), to: cutText(undefined), apply: (x) => withExit(x, 'cut', undefined) });

  for (const t of TRAILS) {
    if (JSON.stringify(t) === JSON.stringify(e.trail)) continue;
    out.push({ key: 'trail', group: 'Trail and break-even', label: trailText(t), from: trailText(e.trail), to: trailText(t), apply: (x) => withExit(x, 'trail', t) });
  }
  for (const b of BREAK_EVENS) {
    if (b === e.breakEven) continue;
    out.push({ key: 'breakEven', group: 'Trail and break-even', label: beText(b), from: beText(e.breakEven), to: beText(b), apply: (x) => withExit(x, 'breakEven', b) });
  }
  // the last run's suggestion as one change, so a result that keeps holding up is found again even when time runs short
  if (previous && JSON.stringify(strip(previous)) !== JSON.stringify(strip(c))) {
    out.unshift({ key: 'previous', group: 'Last run', label: "last run's suggestion", from: 'now', to: 'last suggestion', apply: (x) => ({ ...x, side: previous.side, also: previous.also, exits: previous.exits }) });
  }
  return out;
}

/** The parts of a combination the learner may change. */
export const strip = (/** @type {Combo} */ c) => ({ side: c.side ?? null, also: c.also ?? [], exits: c.exits ?? null });

/**
 * Learns one combination on its own on the older days, then replays old and new on the hidden newest days.
 * @param {{
 *   combo: Combo, base: Settings, days: string[], evaluate: (s: Settings) => Promise<Trade[]>, dayOf: (t: Trade) => string,
 *   labelOf?: (k: string) => string, usable?: (k: string) => boolean, deadline?: number, previous?: Combo | null
 * }} o
 *   base: the user's settings; only this combination is switched on and pattern entries are off, so its trades are its own
 *   previous: this combination as the last run suggested it, tried first
 */
export async function tuneCombo({ combo, base, days, evaluate, dayOf, labelOf = (k) => k, usable = () => true, deadline = Infinity, previous = null }) {
  const head = { id: combo.id, name: combo.name, wasOn: combo.on !== false };
  const split = splitDays(days);
  if (!split) return { ...head, verdict: 'short', text: 'Not enough saved days.', changes: [] };
  const { learn, hidden } = split;
  const alone = (/** @type {Combo} */ c) => /** @type {Settings} */ ({ ...base, patternEntries: false, combos: [{ ...c, on: true }] });
  /** @type {Map<string, Trade[]>} */
  const memo = new Map();
  let tried = 0;
  const run = async (/** @type {Combo} */ c) => {
    const key = JSON.stringify(strip(c));
    if (!memo.has(key)) {
      memo.set(key, await evaluate(alone(c)));
      tried += 1;
    }
    return /** @type {Trade[]} */ (memo.get(key));
  };
  const start = { ...combo };
  const startTrades = await run(start);
  const learnTrades = startTrades.filter((t) => learn.includes(dayOf(t)));
  const ex = excursions(learnTrades);
  const notes = excursionNotes(ex);
  let best = start;
  let bestStat = steady(startTrades, learn, dayOf);
  const startStat = bestStat;
  if (startStat.trades < MIN_LEARN_TRADES) {
    return { ...head, verdict: 'few', text: `Only ${startStat.trades} trade${startStat.trades === 1 ? '' : 's'} on the ${learn.length} learning days: too few to tune it.`, changes: [], learn: { old: startStat, new: startStat }, excursions: ex, notes, tried };
  }
  /** @type {{ key: string, group: string, label: string, from: string, to: string, gain: number }[]} */
  const changes = [];
  let stoppedEarly = false;
  for (let round = 1; round <= COMBO_ROUNDS && changes.length < MAX_COMBO_CHANGES; round++) {
    const moves = comboMoves(best, { labelOf, usable, ex, previous: round === 1 ? previous : null });
    /** @type {{ move: Move, c: Combo, stat: ReturnType<typeof steady> }[]} */
    const rated = [];
    for (const move of moves) {
      if (Date.now() > deadline) {
        stoppedEarly = true;
        break;
      }
      const c = move.apply(best);
      const stat = steady(await run(c), learn, dayOf);
      if (stat.trades >= MIN_LEARN_TRADES && stat.score >= bestStat.score + marginOf(bestStat.score)) rated.push({ move, c, stat });
    }
    rated.sort((a, b) => b.stat.score - a.stat.score);
    // one change a round, the best one that also held through most of the learning days
    const pick = await (async () => {
      for (const r of rated) if (consistent(await run(r.c), await run(best), learn, dayOf)) return r;
      return null;
    })();
    if (!pick) break;
    changes.push({ key: pick.move.key, group: pick.move.group, label: pick.move.label, from: pick.move.from, to: pick.move.to, gain: r2(pick.stat.score - bestStat.score) });
    best = pick.c;
    bestStat = pick.stat;
    if (stoppedEarly) break;
  }
  const oldTrades = await run(start);
  const newTrades = await run(best);
  const hiddenOld = steady(oldTrades, hidden, dayOf);
  const hiddenNew = steady(newTrades, hidden, dayOf);
  const all = { old: steady(oldTrades, [...learn, ...hidden], dayOf), new: steady(newTrades, [...learn, ...hidden], dayOf) };
  const out = { ...head, learn: { old: startStat, new: bestStat }, hidden: { old: hiddenOld, new: hiddenNew }, all, changes, excursions: ex, notes, tried, stoppedEarly, proposal: strip(best), split: { learnDays: learn.length, hiddenDays: hidden.length, hiddenFrom: hidden[0] } };
  if (!changes.length) {
    const word = startStat.net > 0 ? 'Keep it as it is' : 'No setting made it steadily better';
    return { ...out, verdict: 'same', checks: [], text: `${word}: no change helped through the learning days by enough to trust it.` };
  }
  if (hiddenNew.trades < MIN_HIDDEN_TRADES && hiddenOld.trades < MIN_HIDDEN_TRADES) {
    return { ...out, verdict: 'thin', checks: [], text: `Looked better on the learning days, but it made only ${hiddenNew.trades} trade${hiddenNew.trades === 1 ? '' : 's'} on the ${hidden.length} hidden days: too few to check. Paper-test before trusting it.` };
  }
  const checks = judge(hiddenOld, hiddenNew);
  const passed = checks.every((c) => c.ok);
  const text = passed
    ? `Passed: also better on the ${hidden.length} hidden days, ${rs(hiddenNew.net)} against ${rs(hiddenOld.net)}.`
    : `Failed on the ${hidden.length} hidden days: ${checks.filter((c) => !c.ok).map((c) => c.text).join('; ')}.`;
  return { ...out, verdict: passed ? 'passed' : 'failed', checks, text };
}
