// @ts-check
// Learn > Shares: finds better settings for the share auto trader on the saved days. The scanner is replayed once as the live scanner would
// raise its ideas (study/ruleTest.js), then settings are tried on those ideas: the entry hours, which setups trade, the entry rules
// (Nifty agrees, stronger than Nifty, volume, wait for a close, smallest stop) and the exit (the rupee ladder, a profit lock in risks or a
// fixed target). As in tune.js the newest days are hidden while it learns, a change must help through most of the learning days, and old
// and new are then replayed on the hidden days. Not tried here: the minimum score (replayed scores run lower than live ones), the daily
// loss limit and stop-after-losses (kept as they are until the paper test is done).

import { tradesFor } from '../study/ruleTest.js';
import { netResult } from '../scanner/backtest.js';
import { TRY_TARGETS } from '../scanner/replay.js';
import { shareRulesOf } from '../scanner/entryRules.js';
import { splitDays, steady, judge, consistent, marginOf, MIN_LEARN_TRADES } from './tune.js';

/**
 * @typedef {{ minScore: number, entryFrom: number, entryTo: number, skip: string[], trendScore: boolean, earlyNews: boolean, rules: Record<string, any> }} ShareSettings
 * @typedef {{ key: string, group: string, label: string, from: string, to: string, apply: (s: ShareSettings) => ShareSettings }} Move
 */

export const SHARE_MAX_CHANGES = 4;
export const SHARE_ROUNDS = 4;
export const ENTRY_TO = [600, 630, 660, 690, 720, 750, 915];
export const ENTRY_FROM = [555, 570, 585, 600];
export const RULE_TRIES = { minVsNifty: [0, 0.3, 0.5], minRelVol: [0, 1.2, 1.5], minStopPct: [0.3, 0.5, 0.8, 1] };
export const LOCKS_R = [0.35, 0.5];

const r2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;
const rs = (/** @type {number} */ x) => `${x < 0 ? '-' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
const hm = (/** @type {number} */ m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DAY = (/** @type {string} */ iso) => iso.slice(0, 10);

/** The share settings the learner can change, read from the saved AutoSettings. */
export function shareSettingsOf(/** @type {any} */ auto) {
  return {
    minScore: auto?.minScore ?? 70,
    entryFrom: auto?.entryFrom ?? 555,
    entryTo: auto?.entryTo ?? 915,
    skip: [...(auto?.skipSetups ?? [])].sort(),
    trendScore: auto?.trendScore === true,
    earlyNews: auto?.earlyNews !== false,
    rules: shareRulesOf(auto?.shareRules),
  };
}

/** What is saved for a set of share settings (PUT-able AutoSettings fields). */
export const sharePatch = (/** @type {ShareSettings} */ s) => ({ entryFrom: s.entryFrom, entryTo: s.entryTo, skipSetups: s.skip, shareRules: s.rules });

export const exitWords = (/** @type {Record<string, any>} */ r) => (r.target > 0 ? `sell at +${rs(r.target)}` : r.lockFromR > 0 ? `profit lock from +${r.lockFromR}R` : 'your rupee profit ladder');

/** The trades a set of settings takes from the ideas, as { entryTime, net, day }. */
export function shareTrades(/** @type {any[]} */ ideas, /** @type {ShareSettings} */ s, /** @type {any} */ opts) {
  const skip = new Set(s.skip);
  const setupOn = (/** @type {string} */ x) => !skip.has(x) && (x !== 'Trend score' || s.trendScore) && (x !== 'News gap' || s.earlyNews);
  return tradesFor(ideas, { minScore: s.minScore, setupOn, rules: { ...s.rules, entryFrom: s.entryFrom, entryTo: s.entryTo } })
    .map((t) => ({ entryTime: Date.parse(t.openedAt) / 1000, day: DAY(t.openedAt), setup: t.setup, side: t.side, net: netResult(t, opts)?.net ?? 0 }));
}

/**
 * Every single change worth trying from `s`.
 * @param {ShareSettings} s
 * @param {string[]} setups  the setups that raised ideas on the saved days
 * @returns {Move[]}
 */
export function shareMoves(s, setups) {
  /** @type {Move[]} */
  const out = [];
  const rule = (/** @type {string} */ key, /** @type {any} */ value) => (/** @type {ShareSettings} */ x) => ({ ...x, rules: { ...x.rules, [key]: value } });
  for (const v of ENTRY_TO) if (v !== s.entryTo && v > s.entryFrom) out.push({ key: 'entryTo', group: 'Entry hours', label: `No new share trade from ${hm(v)}`, from: hm(s.entryTo), to: hm(v), apply: (x) => ({ ...x, entryTo: v }) });
  for (const v of ENTRY_FROM) if (v !== s.entryFrom && v < s.entryTo) out.push({ key: 'entryFrom', group: 'Entry hours', label: `First share trade at ${hm(v)}`, from: hm(s.entryFrom), to: hm(v), apply: (x) => ({ ...x, entryFrom: v }) });
  for (const setup of setups) {
    const off = s.skip.includes(setup);
    out.push({ key: `setup:${setup}`, group: 'Setups', label: `${off ? 'Switch on' : 'Switch off'} ${setup}`, from: off ? 'off' : 'on', to: off ? 'on' : 'off', apply: (x) => ({ ...x, skip: off ? x.skip.filter((k) => k !== setup) : [...x.skip, setup].sort() }) });
  }
  for (const k of ['marketAgree', 'confirmBar']) {
    const on = Boolean(s.rules[k]);
    const name = k === 'marketAgree' ? 'Nifty must agree' : 'Wait for a 5-minute close past the entry';
    out.push({ key: k, group: 'Entry rules', label: `${name}: ${on ? 'off' : 'on'}`, from: on ? 'on' : 'off', to: on ? 'off' : 'on', apply: rule(k, !on) });
  }
  const words = { minVsNifty: (/** @type {number} */ v) => (v ? `at least ${v}% stronger than Nifty` : 'any strength vs Nifty'), minRelVol: (/** @type {number} */ v) => (v ? `volume at least ${v}x normal` : 'any volume'), minStopPct: (/** @type {number} */ v) => `smallest stop ${v}%` };
  for (const [k, list] of Object.entries(RULE_TRIES)) {
    const word = /** @type {(v: number) => string} */ (/** @type {any} */ (words)[k]);
    for (const v of list) if (v !== s.rules[k]) out.push({ key: k, group: 'Entry rules', label: word(v), from: word(s.rules[k] ?? 0), to: word(v), apply: rule(k, v) });
  }
  const exits = [{ target: 0, lockFromR: 0 }, ...LOCKS_R.map((r) => ({ target: 0, lockFromR: r })), ...TRY_TARGETS.map((t) => ({ target: t, lockFromR: 0 }))];
  for (const e of exits) {
    if ((s.rules.target ?? 0) === e.target && (s.rules.lockFromR ?? 0) === e.lockFromR) continue;
    out.push({ key: 'exit', group: 'Exit', label: `Exit: ${exitWords(e)}`, from: exitWords(s.rules), to: exitWords(e), apply: (x) => ({ ...x, rules: { ...x.rules, ...e } }) });
  }
  return out;
}

/** What the trades say by setup, side and hour (all days), for the notes under the result. */
export function shareFacts(/** @type {{ setup: string, side: string, entryTime: number, net: number }[]} */ trades) {
  const by = (/** @type {(t: any) => string} */ key) => {
    const m = new Map();
    for (const t of trades) {
      const k = key(t);
      const x = m.get(k) || { key: k, trades: 0, wins: 0, net: 0 };
      x.trades += 1;
      x.wins += t.net > 0 ? 1 : 0;
      x.net = r2(x.net + t.net);
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.net - a.net);
  };
  const hour = (/** @type {any} */ t) => `${String(Math.floor(((t.entryTime + 19800) % 86400) / 3600)).padStart(2, '0')}:00`;
  return { bySetup: by((t) => `${t.setup} (${t.side === 'BUY' ? 'buys' : 'sells'})`), byHour: by(hour).sort((a, b) => a.key.localeCompare(b.key)) };
}

/**
 * @param {{ ideas: any[], current: ShareSettings, opts: any, deadline?: number, hints?: string[] }} o
 */
export async function tuneShares({ ideas, current, opts, deadline = Infinity, hints = [] }) {
  const days = [...new Set(ideas.map((i) => DAY(i.openedAt)))].sort();
  const split = splitDays(days);
  const dayOf = (/** @type {any} */ t) => t.day;
  if (!split) return { verdict: 'short', text: `Not enough saved days with share ideas: it needs at least 9 and found ${days.length}. Download more days in Research > Saved data.`, changes: [], days: days.length };
  const { learn, hidden } = split;
  const setups = [...new Set(ideas.map((i) => i.setup))].sort();
  /** @type {Map<string, any[]>} */
  const memo = new Map();
  let tried = 0;
  const run = (/** @type {ShareSettings} */ s) => {
    const key = JSON.stringify(s);
    if (!memo.has(key)) {
      memo.set(key, shareTrades(ideas, s, opts));
      tried += 1;
    }
    return /** @type {any[]} */ (memo.get(key));
  };
  let best = current;
  let bestStat = steady(run(current), learn, dayOf);
  const start = bestStat;
  /** @type {{ key: string, group: string, label: string, from: string, to: string, gain: number }[]} */
  const changes = [];
  let stoppedEarly = false;
  const hinted = new Set(hints);
  for (let round = 1; round <= SHARE_ROUNDS && changes.length < SHARE_MAX_CHANGES; round++) {
    const moves = shareMoves(best, setups).sort((a, b) => Number(hinted.has(b.label)) - Number(hinted.has(a.label)));
    const rated = [];
    for (const move of moves) {
      if (Date.now() > deadline) {
        stoppedEarly = true;
        break;
      }
      const next = move.apply(best);
      const stat = steady(run(next), learn, dayOf);
      if (stat.trades >= MIN_LEARN_TRADES && stat.score >= bestStat.score + marginOf(bestStat.score)) rated.push({ move, next, stat });
    }
    rated.sort((a, b) => b.stat.score - a.stat.score);
    const pick = rated.find((r) => consistent(run(r.next), run(best), learn, dayOf));
    if (!pick) break;
    changes.push({ key: pick.move.key, group: pick.move.group, label: pick.move.label, from: pick.move.from, to: pick.move.to, gain: r2(pick.stat.score - bestStat.score) });
    best = pick.next;
    bestStat = pick.stat;
    if (stoppedEarly) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const oldT = run(current);
  const newT = run(best);
  const hiddenOld = steady(oldT, hidden, dayOf);
  const hiddenNew = steady(newT, hidden, dayOf);
  const facts = shareFacts(oldT);
  const base = { split: { learnDays: learn.length, hiddenDays: hidden.length, from: days[0], to: days.at(-1), hiddenFrom: hidden[0] }, learn: { old: start, new: bestStat }, hidden: { old: hiddenOld, new: hiddenNew }, all: { old: steady(oldT, days, dayOf), new: steady(newT, days, dayOf) }, changes, tried, stoppedEarly, facts, ideas: ideas.length, proposal: best };
  if (!changes.length) return { ...base, verdict: 'same', checks: [], text: `No change helped through the ${learn.length} learning days by enough to trust it. ${tried} settings tried.` };
  const checks = judge(hiddenOld, hiddenNew);
  const passed = checks.every((c) => c.ok);
  const text = passed
    ? `Passed: also better on the newest ${hidden.length} days it never saw, ${rs(hiddenNew.net)} against ${rs(hiddenOld.net)}.`
    : `Failed on the newest ${hidden.length} days it never saw: ${checks.filter((c) => !c.ok).map((c) => c.text).join('; ')}.`;
  return { ...base, verdict: passed ? 'passed' : 'failed', checks, text };
}
