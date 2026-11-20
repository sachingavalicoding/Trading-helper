// @ts-check
// Lab > Learn: the settings learner for options. It tries changes to the whole paper-trading setup (which combinations are on and on which
// side, an extra indicator on a combination, the trades a day and loss limits, the stop, the profit ladder, the entry hours) on the saved
// days, judged by how steady the profit is, not only by the rupees. The newest days (about 1 in 4) are kept hidden while it learns; then the
// old and the new settings are both replayed on those hidden days, and the new ones pass only if they did better there too.
// This file only decides; the replay itself is passed in (`evaluate`), so the same rules the live trader uses are the ones judged.

/**
 * @typedef {{ at: number, keep: number }} Step
 * @typedef {{ mode: string, k?: number, points?: number }} StopRule
 * @typedef {{ points: number, start: number }} Trail
 * @typedef {{ id: string, name: string, conds: string[], also?: string[], need?: number, window?: number, on?: boolean, side?: string, [k: string]: any }} Combo
 * @typedef {{
 *   combos: Combo[], patternEntries: boolean, patterns: string[], maxTrades: number, dailyLossPct: number, lossLimit: number, lossStreak: number,
 *   steps: Step[], stopRule: StopRule, trail: Trail | null, breakEven: number, entryFrom: number, entryTo: number
 * }} Settings
 * @typedef {{ entryTime: number, net: number }} Trade
 * @typedef {{
 *   days: number, trades: number, wins: number, winRate: number | null, net: number, avgDay: number, goodDays: number, badDays: number,
 *   worstDay: number, bestDay: number, avgWin: number | null, avgLoss: number | null, payoff: number | null, downside: number, score: number
 * }} Steady
 * @typedef {{ key: string, group: string, label: string, from: string, to: string, apply: (s: Settings) => Settings }} Move
 */

export const HOLD_OUT = 0.25; // the newest quarter of the days is hidden while learning
export const MIN_HIDDEN = 3;
export const MIN_DAYS = 9; // fewer saved days and nothing is learned: 6 to learn on and 3 to check is already thin
export const MIN_LEARN_TRADES = 6; // a setup with fewer trades on the learning days is not judged (too few to say anything)
export const MIN_HIDDEN_TRADES = 3;
export const MAX_CHANGES = 6; // more changes than this and the result is mostly fitted to the past
export const ROUNDS = 2;
export const WINDOWS = [5, 10, 15];
const DOWNSIDE_WEIGHT = 0.5;
const PAYOFF_WEIGHT = 0.15;

const r2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;
const rs = (/** @type {number} */ x) => `${x < 0 ? '-' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
const hm = (/** @type {number} */ m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The newest ~1 in 4 days (at least MIN_HIDDEN) are hidden; null when there are too few days to learn from. */
export function splitDays(/** @type {string[]} */ days) {
  const sorted = [...days].sort();
  if (sorted.length < MIN_DAYS) return null;
  const hidden = Math.max(MIN_HIDDEN, Math.round(sorted.length * HOLD_OUT));
  return { learn: sorted.slice(0, sorted.length - hidden), hidden: sorted.slice(sorted.length - hidden) };
}

/**
 * How steady a set of trades was over a set of days. Days with no trade count as 0 (not as bad days).
 * The score, in rupees a day: the average day minus half the typical size of a losing day (the root mean square of the losing days,
 * with good days as 0), then nudged up to 15% for a good win/loss ratio (average win over average loss) or down for a poor one.
 * So two setups with the same total rank the one with fewer and smaller bad days first.
 * @param {Trade[]} trades
 * @param {string[]} days    the day keys (YYYY-MM-DD) the trades are judged over
 * @param {(t: Trade) => string} dayOf
 * @returns {Steady}
 */
export function steady(trades, days, dayOf) {
  const set = new Set(days);
  const mine = trades.filter((t) => set.has(dayOf(t)));
  /** @type {Map<string, number>} */
  const byDay = new Map(days.map((d) => [d, 0]));
  for (const t of mine) byDay.set(dayOf(t), (byDay.get(dayOf(t)) ?? 0) + t.net);
  const nets = [...byDay.values()];
  const n = Math.max(nets.length, 1);
  const net = nets.reduce((s, x) => s + x, 0);
  const wins = mine.filter((t) => t.net > 0);
  const losses = mine.filter((t) => t.net <= 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.net, 0) / wins.length : null;
  const avgLoss = losses.length ? -losses.reduce((s, t) => s + t.net, 0) / losses.length : null;
  const payoff = avgWin != null && avgLoss != null && avgLoss > 0 ? avgWin / avgLoss : avgWin != null ? 2 : null;
  const downside = Math.sqrt(nets.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / n);
  const avgDay = net / n;
  const base = avgDay - DOWNSIDE_WEIGHT * downside;
  const factor = 1 + PAYOFF_WEIGHT * Math.max(-1, Math.min(1, (payoff ?? 1) - 1));
  const score = mine.length ? (base >= 0 ? base * factor : base / factor) : 0;
  return {
    days: nets.length,
    trades: mine.length,
    wins: wins.length,
    winRate: mine.length ? Math.round((wins.length / mine.length) * 100) : null,
    net: r2(net),
    avgDay: r2(avgDay),
    goodDays: nets.filter((x) => x > 0).length,
    badDays: nets.filter((x) => x < 0).length,
    worstDay: r2(Math.min(0, ...nets)),
    bestDay: r2(Math.max(0, ...nets)),
    avgWin: avgWin == null ? null : r2(avgWin),
    avgLoss: avgLoss == null ? null : r2(avgLoss),
    payoff: payoff == null ? null : r2(payoff),
    downside: r2(downside),
    score: r2(score),
  };
}

export const CHUNKS = 3;

/**
 * Whether a change helped through the learning days and not only on a few of them: the learning days cut in CHUNKS parts by date, and the
 * new trades must score at least as well as the old ones in most parts. A change that wins by one lucky day fails this.
 * @param {Trade[]} neu @param {Trade[]} old @param {string[]} learn @param {(t: Trade) => string} dayOf
 */
export function consistent(neu, old, learn, dayOf) {
  if (learn.length < CHUNKS * 2) return true;
  const size = Math.ceil(learn.length / CHUNKS);
  let wins = 0;
  let parts = 0;
  for (let i = 0; i < learn.length; i += size) {
    const part = learn.slice(i, i + size);
    parts += 1;
    if (steady(neu, part, dayOf).score >= steady(old, part, dayOf).score) wins += 1;
  }
  return wins * 2 > parts;
}

/** The smallest gain in score (rupees a day) a change must bring on the learning days to be kept: small gains are mostly noise. */
export const marginOf = (/** @type {number} */ score) => Math.max(25, 0.05 * Math.abs(score));

// ---------- what can be changed ----------

/** A ladder that starts at `start` and keeps `gap` under the gain, rising every ₹500 (the same rows Account > Entries makes from "first lock" and "room"). */
export const roomLadder = (/** @type {number} */ start, /** @type {number} */ gap) => Array.from({ length: 8 }, (_, i) => ({ at: start + i * 500, keep: Math.max(1, start + i * 500 - gap) }));

export const LADDERS = [
  { key: 'none', label: 'no profit lock', steps: [] },
  { key: 'r750', label: 'small target: at +₹750 keep ₹700, then every ₹500', steps: roomLadder(750, 50) },
  { key: 'r1000', label: 'at +₹1,000 keep ₹900, then every ₹500', steps: roomLadder(1000, 100) },
  { key: 'l600', label: 'at +₹600 keep ₹300', steps: [{ at: 600, keep: 300 }] },
  { key: 'l1000', label: 'at +₹1,000 keep ₹750', steps: [{ at: 1000, keep: 750 }] },
  { key: 'l800_1500', label: 'at +₹800 keep ₹500, at +₹1,500 keep ₹1,200', steps: [{ at: 800, keep: 500 }, { at: 1500, keep: 1200 }] },
  { key: 'l500_2000', label: 'at +₹500 keep ₹250, +₹1,000 keep ₹700, +₹2,000 keep ₹1,600', steps: [{ at: 500, keep: 250 }, { at: 1000, keep: 700 }, { at: 2000, keep: 1600 }] },
  { key: 'l1500_3000', label: 'at +₹1,500 keep ₹1,200, at +₹3,000 keep ₹2,600', steps: [{ at: 1500, keep: 1200 }, { at: 3000, keep: 2600 }] },
];
export const STOPS = [
  { mode: 'chart' },
  { mode: 'cap', k: 1.5 },
  { mode: 'cap', k: 2 },
  { mode: 'atr', k: 1 },
  { mode: 'atr', k: 1.5 },
  { mode: 'atr', k: 2 },
  { mode: 'fixed', points: 20 },
  { mode: 'fixed', points: 30 },
  { mode: 'fixed', points: 40 },
];
export const TRAILS = [null, { points: 20, start: 20 }, { points: 30, start: 30 }, { points: 50, start: 40 }];
export const LIMITS = { maxTrades: [1, 2, 3, 4, 5], dailyLossPct: [2, 3, 5, 8, 10], lossLimit: [750, 1000, 1500, 2000, 2500, 3000], lossStreak: [0, 1, 2, 3], breakEven: [0, 20, 40] };
export const HOURS = { entryFrom: [555, 570, 600], entryTo: [840, 870, 900, 915] };
// the indicator filters the learner may add to a combination: the main indicators (RSI, MACD, EMA, VWAP, Bollinger, ATR, Supertrend, ADX)
// and the options ones (PCR, IV percentile, OI change, max pain, delta, theta)
export const FILTERS = [
  'rsiAbove50', 'rsiAbove60', 'rsiNotStretched', 'macdAbove', 'macdBothUp', 'emaFastOverSlow', 'ema5Over13', 'aboveEma50', 'aboveVwap', 'vwapNear',
  'bbAboveMid', 'bbPctB', 'atrExpand', 'atrCalm', 'atrAwake', 'supertrendUp', 'supertrendSlowUp', 'adxUp', 'adx30Up', 'adxRising',
  'pcrAbove1', 'pcrAbove12', 'pcrRising', 'oiBacks', 'oiFresh', 'belowMaxPain', 'aboveMaxPain', 'ivLow', 'ivNotHigh', 'ivRising', 'deltaNearMoney', 'deltaStrong', 'thetaLow', 'thetaVeryLow',
  // yesterday's levels (a put reads each one turned round: below yesterday's close, low, pivot...)
  'aboveYClose', 'aboveYHigh', 'abovePivot', 'aboveCpr', 'aboveYValue', 'abovePoc', 'cprHigher',
];
export const NEW_BASES = ['p_breakout', 'p_engulfing', 'p_momentumBar']; // the patterns that paid in the earlier studies, tried as a new combination
export const NEW_PREFIX = 'learn-';
const MAX_TUNED_COMBOS = 8;
const MAX_FILTERED_COMBOS = 4;

export const stopWords = (/** @type {StopRule} */ r) => (r.mode === 'fixed' ? `${r.points} points from entry` : r.mode === 'atr' ? `${r.k} ATR from entry` : r.mode === 'cap' ? `chart level, at most ${r.k} ATR` : 'chart level');
export const trailWords = (/** @type {Trail|null} */ t) => (t ? `trail ${t.points} points once ${t.start} points up` : 'no trailing stop');
export const ladderWords = (/** @type {Step[]} */ steps) => (steps.length ? steps.map((s) => `at +${rs(s.at)} keep ${rs(s.keep)}`).join(', ') : 'no profit lock');
const sideWords = (/** @type {string|undefined} */ side) => (side === 'CE' ? 'calls only' : side === 'PE' ? 'puts only' : 'calls and puts');
const sameStop = (/** @type {StopRule} */ a, /** @type {StopRule} */ b) => a.mode === b.mode && (a.mode === 'chart' || (a.mode === 'fixed' ? a.points === b.points : a.k === b.k));
const sameSteps = (/** @type {Step[]} */ a, /** @type {Step[]} */ b) => JSON.stringify(a) === JSON.stringify(b);

/** @param {Settings} s @param {string} id @param {(c: Combo) => Combo} f */
const withCombo = (s, id, f) => ({ ...s, combos: s.combos.map((c) => (c.id === id ? f(c) : c)) });

/**
 * Every single change worth trying from `s`. `labelOf` names a check; `usable(key)` says whether the data has what the check needs.
 * @param {Settings} s
 * @param {{ labelOf: (k: string) => string, usable: (k: string) => boolean, patterns?: { key: string, label: string }[], maxCombos?: number }} o
 * @returns {Move[]}
 */
export function movesFor(s, { labelOf, usable, patterns = [], maxCombos = 30 }) {
  /** @type {Move[]} */
  const out = [];
  const combos = [...s.combos].sort((a, b) => Number(b.on !== false) - Number(a.on !== false)).slice(0, MAX_TUNED_COMBOS);
  const usableCombo = (/** @type {Combo} */ c) => [...c.conds, ...(c.also ?? [])].every(usable);
  for (const c of combos) {
    if (!usableCombo(c)) continue;
    const on = c.on !== false;
    out.push({ key: `combo:${c.id}:on`, group: 'Combinations', label: `${on ? 'Switch off' : 'Switch on'} ${c.name}`, from: on ? 'on' : 'off', to: on ? 'off' : 'on', apply: (x) => withCombo(x, c.id, (y) => ({ ...y, on: !on })) });
    if (!on) continue;
    for (const side of [undefined, 'CE', 'PE']) {
      if ((c.side ?? undefined) === side) continue;
      out.push({ key: `combo:${c.id}:side`, group: 'Combinations', label: `${c.name}: ${sideWords(side)}`, from: sideWords(c.side), to: sideWords(side), apply: (x) => withCombo(x, c.id, (y) => { const { side: _drop, ...rest } = y; return side ? { ...rest, side } : rest; }) });
    }
  }
  // an extra indicator on a switched-on combination (all must hold), or one the learner added taken away again
  for (const c of combos.filter((x) => x.on !== false && usableCombo(x)).slice(0, MAX_FILTERED_COMBOS)) {
    const have = new Set([...c.conds, ...(c.also ?? [])]);
    for (const k of FILTERS) {
      if (have.has(k) || !usable(k)) continue;
      out.push({ key: `combo:${c.id}:also`, group: 'Indicators', label: `${c.name}: add ${labelOf(k)}`, from: '–', to: labelOf(k), apply: (x) => withCombo(x, c.id, (y) => ({ ...y, also: [...(y.also ?? []), k] })) });
    }
    for (const k of c.also ?? []) {
      out.push({ key: `combo:${c.id}:also`, group: 'Indicators', label: `${c.name}: take away ${labelOf(k)}`, from: labelOf(k), to: '–', apply: (x) => withCombo(x, c.id, (y) => ({ ...y, also: (y.also ?? []).filter((z) => z !== k) })) });
    }
  }
  // a new combination from one of the patterns that paid before, when there is room
  if (s.combos.length < maxCombos) {
    for (const base of NEW_BASES) {
      if (!usable(base) || s.combos.some((c) => c.conds.length === 1 && c.conds[0] === base)) continue;
      const id = `${NEW_PREFIX}${base.slice(2)}`;
      out.push({ key: `new:${base}`, group: 'Combinations', label: `New combination: ${labelOf(base)}`, from: '–', to: labelOf(base), apply: (x) => (x.combos.some((c) => c.id === id) ? x : { ...x, combos: [...x.combos, { id, name: `Learn: ${labelOf(base)}`.slice(0, 60), conds: [base], need: 1, window: 3, on: true }] }) });
    }
  }
  // the pattern entries (Account > Entries > Patterns)
  if (patterns.length) {
    out.push({ key: 'patternEntries', group: 'Combinations', label: `Pattern entries ${s.patternEntries ? 'off' : 'on'}`, from: s.patternEntries ? 'on' : 'off', to: s.patternEntries ? 'off' : 'on', apply: (x) => ({ ...x, patternEntries: !x.patternEntries }) });
    if (s.patternEntries) {
      for (const p of patterns) {
        const on = s.patterns.includes(p.key);
        if (on && s.patterns.length === 1) continue;
        out.push({ key: `pattern:${p.key}`, group: 'Combinations', label: `Pattern ${p.label} ${on ? 'off' : 'on'}`, from: on ? 'on' : 'off', to: on ? 'off' : 'on', apply: (x) => ({ ...x, patterns: on ? x.patterns.filter((k) => k !== p.key) : [...x.patterns, p.key] }) });
      }
    }
  }
  const num = (/** @type {'maxTrades'|'dailyLossPct'|'lossLimit'|'lossStreak'|'breakEven'} */ key, /** @type {string} */ group, /** @type {string} */ name, /** @type {(v: number) => string} */ word) => {
    for (const v of LIMITS[key]) if (v !== s[key]) out.push({ key, group, label: `${name}: ${word(v)}`, from: word(s[key]), to: word(v), apply: (x) => ({ ...x, [key]: v }) });
  };
  num('maxTrades', 'Limits', 'Trades a day', (v) => (v ? String(v) : 'no limit'));
  num('dailyLossPct', 'Limits', 'Daily loss limit', (v) => `${v}% of budget`);
  num('lossLimit', 'Stop loss', 'Most one trade may lose', (v) => rs(v));
  num('lossStreak', 'Limits', 'Stop for the day after', (v) => (v ? `${v} loss${v === 1 ? '' : 'es'} in a row` : 'never'));
  num('breakEven', 'Stop loss', 'Stop to entry after', (v) => (v ? `${v} points` : 'off'));
  for (const l of LADDERS) if (!sameSteps(l.steps, s.steps)) out.push({ key: 'steps', group: 'Profit ladder', label: `Profit ladder: ${l.label}`, from: ladderWords(s.steps), to: l.label, apply: (x) => ({ ...x, steps: l.steps }) });
  for (const f of [0.75, 1.5]) {
    if (!s.steps.length) continue;
    const steps = s.steps.map((st) => ({ at: Math.round((st.at * f) / 50) * 50, keep: Math.round((st.keep * f) / 50) * 50 })).filter((st) => st.at > st.keep && st.keep >= 0);
    if (steps.length && !sameSteps(steps, s.steps)) out.push({ key: 'steps', group: 'Profit ladder', label: `Profit ladder ${f < 1 ? 'tighter' : 'wider'}: ${ladderWords(steps)}`, from: ladderWords(s.steps), to: ladderWords(steps), apply: (x) => ({ ...x, steps }) });
  }
  for (const r of STOPS) if (!sameStop(r, s.stopRule)) out.push({ key: 'stopRule', group: 'Stop loss', label: `Stop: ${stopWords(r)}`, from: stopWords(s.stopRule), to: stopWords(r), apply: (x) => ({ ...x, stopRule: r }) });
  for (const t of TRAILS) if (JSON.stringify(t) !== JSON.stringify(s.trail)) out.push({ key: 'trail', group: 'Stop loss', label: `Trailing stop: ${trailWords(t)}`, from: trailWords(s.trail), to: trailWords(t), apply: (x) => ({ ...x, trail: t }) });
  for (const v of HOURS.entryFrom) if (v !== s.entryFrom && v < s.entryTo) out.push({ key: 'entryFrom', group: 'Entry hours', label: `First entry at ${hm(v)}`, from: hm(s.entryFrom), to: hm(v), apply: (x) => ({ ...x, entryFrom: v }) });
  for (const v of HOURS.entryTo) if (v !== s.entryTo && v > s.entryFrom) out.push({ key: 'entryTo', group: 'Entry hours', label: `No new entry from ${hm(v)}`, from: hm(s.entryTo), to: hm(v), apply: (x) => ({ ...x, entryTo: v }) });
  return out;
}

// ---------- the search ----------

/**
 * Learns on the older days, then replays old and new settings on the hidden newest days.
 * @param {{
 *   days: string[], current: Settings, evaluate: (s: Settings) => Promise<Trade[]>, dayOf: (t: Trade) => string,
 *   labelOf?: (k: string) => string, usable?: (k: string) => boolean, patterns?: { key: string, label: string }[], maxCombos?: number,
 *   onProgress?: (text: string) => void, deadline?: number, hints?: string[]
 * }} o
 *   deadline: a time (ms) after which no more changes are tried; what was found so far is still judged on the hidden days
 *   hints: labels of changes that passed in earlier runs; they are tried first, so a run builds on the last ones even when time runs short
 */
export async function tune({ days, current, evaluate, dayOf, labelOf = (k) => k, usable = () => true, patterns = [], maxCombos = 30, onProgress = () => {}, deadline = Infinity, hints = [] }) {
  const split = splitDays(days);
  const all = [...days].sort();
  if (!split) return { verdict: 'short', text: `Not enough saved days to learn from: it needs at least ${MIN_DAYS} and found ${all.length}. Nothing was changed.`, days: all.length, changes: [], tried: 0 };
  const { learn, hidden } = split;
  let tried = 0;
  /** @type {Map<string, Trade[]>} */
  const memo = new Map();
  const run = async (/** @type {Settings} */ s) => {
    const key = JSON.stringify(s);
    if (!memo.has(key)) {
      memo.set(key, await evaluate(s));
      tried += 1;
    }
    return /** @type {Trade[]} */ (memo.get(key));
  };
  const onLearn = async (/** @type {Settings} */ s) => steady(await run(s), learn, dayOf);
  onProgress('Replaying your current settings');
  let best = current;
  let bestStat = await onLearn(current);
  const start = bestStat;
  /** @type {{ key: string, group: string, label: string, from: string, to: string, gain: number, hinted?: boolean }[]} */
  const changes = [];
  let stoppedEarly = false;
  let uneven = 0;
  const late = () => {
    if (Date.now() > deadline) stoppedEarly = true;
    return stoppedEarly;
  };
  for (let round = 1; round <= ROUNDS && changes.length < MAX_CHANGES; round++) {
    const hinted = new Set(hints);
    const moves = movesFor(best, { labelOf, usable, patterns, maxCombos }).sort((a, b) => Number(hinted.has(b.label)) - Number(hinted.has(a.label)));
    /** @type {{ move: Move, stat: Steady }[]} */
    const rated = [];
    for (const [n, move] of moves.entries()) {
      if (late()) break;
      if (n % 10 === 0) onProgress(`Round ${round}: trying change ${n + 1} of ${moves.length}`);
      const stat = await onLearn(move.apply(best));
      if (stat.trades >= MIN_LEARN_TRADES && stat.score >= bestStat.score + marginOf(bestStat.score)) rated.push({ move, stat });
    }
    rated.sort((a, b) => b.stat.score - a.stat.score);
    const touched = new Set();
    let took = 0;
    for (const { move } of rated) {
      if (changes.length >= MAX_CHANGES || late()) break;
      if (touched.has(move.key)) continue; // one change per setting a round: two stops or two ladders do not stack
      const next = move.apply(best);
      const stat = await onLearn(next);
      if (stat.trades < MIN_LEARN_TRADES || stat.score < bestStat.score + marginOf(bestStat.score)) continue;
      if (!consistent(await run(next), await run(best), learn, dayOf)) {
        uneven += 1; // better in total but only thanks to part of the learning days: likely luck
        continue;
      }
      changes.push({ key: move.key, group: move.group, label: move.label, from: move.from, to: move.to, gain: r2(stat.score - bestStat.score), hinted: hinted.has(move.label) });
      touched.add(move.key);
      best = next;
      bestStat = stat;
      took += 1;
    }
    if (!took || stoppedEarly) break;
  }

  onProgress('Replaying old and new settings on the hidden days');
  const oldTrades = await run(current);
  const newTrades = await run(best);
  const hiddenOld = steady(oldTrades, hidden, dayOf);
  const hiddenNew = steady(newTrades, hidden, dayOf);
  const hiddenSet = new Set(hidden);
  const windows = WINDOWS.filter((w, i) => i === 0 || all.length > WINDOWS[i - 1]).map((w) => {
    const span = all.slice(-w);
    return { days: span.length, from: span[0], to: span.at(-1), hidden: span.filter((d) => hiddenSet.has(d)).length, old: steady(oldTrades, span, dayOf), new: steady(newTrades, span, dayOf) };
  });
  const base = { split: { learnDays: learn.length, hiddenDays: hidden.length, from: all[0], to: all.at(-1), hiddenFrom: hidden[0] }, learn: { old: start, new: bestStat }, hidden: { old: hiddenOld, new: hiddenNew }, windows, changes, tried, uneven, stoppedEarly, proposal: best };
  if (!changes.length) {
    const none = start.trades === 0 ? ` Your current settings made no trade on the ${learn.length} learning days, so check that some combinations or patterns are switched on in Account > Entries.` : '';
    return { ...base, verdict: 'same', checks: [], text: `No change helped on the ${learn.length} learning days by enough to trust it, so your settings stay as they are. ${tried} settings were tried.${none}` };
  }
  const checks = judge(hiddenOld, hiddenNew);
  const passed = checks.every((c) => c.ok);
  const text = passed
    ? `Passed. ${changes.length} change${changes.length === 1 ? '' : 's'} learned on the older ${learn.length} days also did better on the newest ${hidden.length} days it never saw: ${rs(hiddenNew.net)} against ${rs(hiddenOld.net)}, ${hiddenNew.badDays} bad day${hiddenNew.badDays === 1 ? '' : 's'} against ${hiddenOld.badDays}.`
    : `Failed. The changes looked better on the ${learn.length} learning days but not on the newest ${hidden.length} days it never saw: ${checks.filter((c) => !c.ok).map((c) => c.text).join('; ')}. That is what fitting the past looks like, so Apply is blocked.`;
  return { ...base, verdict: passed ? 'passed' : 'failed', checks, text };
}

/**
 * The pass test on the hidden days: steadier (a higher score), at least as much money and in profit, no more bad days, and enough trades to tell.
 * @param {Steady} old
 * @param {Steady} neu
 */
export const ONE_DAY_SHARE = 0.6; // with enough hidden days, no single day may be more than this share of the new profit
export const ONE_DAY_MIN_DAYS = 4;
export function judge(old, neu) {
  const lone = neu.days >= ONE_DAY_MIN_DAYS && neu.net > 0 && neu.bestDay > ONE_DAY_SHARE * neu.net;
  return [
    { key: 'score', ok: neu.score > old.score, text: neu.score > old.score ? `steadier: ${rs(neu.score)} a day against ${rs(old.score)}` : `not steadier: score ${rs(neu.score)} a day against ${rs(old.score)}` },
    { key: 'profit', ok: neu.net > 0 && neu.net >= old.net, text: neu.net > 0 && neu.net >= old.net ? `made ${rs(neu.net)} against ${rs(old.net)}` : neu.net === 0 ? 'made nothing' : neu.net < 0 ? `lost money (${rs(neu.net)})` : `made less (${rs(neu.net)} against ${rs(old.net)})` },
    { key: 'badDays', ok: neu.badDays <= old.badDays, text: neu.badDays <= old.badDays ? `${neu.badDays} losing day${neu.badDays === 1 ? '' : 's'} against ${old.badDays}` : `more losing days (${neu.badDays} against ${old.badDays})` },
    { key: 'oneDay', ok: !lone, text: lone ? `one day gave ${Math.round((neu.bestDay / neu.net) * 100)}% of the profit (${rs(neu.bestDay)} of ${rs(neu.net)}); without it ${rs(neu.net - neu.bestDay)}` : 'no single day carried the profit' },
    { key: 'trades', ok: neu.trades >= MIN_HIDDEN_TRADES, text: neu.trades >= MIN_HIDDEN_TRADES ? `${neu.trades} trades to judge by` : `only ${neu.trades} trade${neu.trades === 1 ? '' : 's'}, too few to judge` },
  ];
}
