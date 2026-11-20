// @ts-check
import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { prepare, findSignals, turnoverSeries } from '../study/patterns.js';
import { botSignals, breadthSeries, dailyFrom, tradesFor } from '../study/optionsStudy.js';
import { buildChart, usable, CONDITION_BY_KEY } from '../combos/conditions.js';
import { comboSignals, comboExits } from '../combos/combos.js';
import { activeBot } from '../combos/bot.js';
import { optionSeries } from '../combos/optionData.js';
import { entryTest } from '../options/signal.js';

// The replay Lab > Learn judges settings with: the index chart of the saved days built once (with the option-chain series where real
// prices were saved), and for any settings the trades the live rules would have made (study/optionsStudy.js tradesFor: one call and
// one put at a time, the pauses, the trades a day, the daily loss limit, the stop sizing the lots, the profit ladder, real premiums).
// As live (and as Replay), it also takes your indicator-score entries (`params.scoreEntries`, score `params.scoreMin`+) and skips a
// combination or pattern whose side's chart score is under your minimum (`params.comboMinScore`, `params.patternMinScore`). Without these
// two, Learn counted trades live never takes, and missed the score trades that hold the one-call/one-put slot (20 Nov check: 19 Nov was
// +3,114 in Learn and -1,857 in Replay with the same settings).

/** @typedef {import('./tune.js').Settings} Settings */

/** @param {number} t */
export const dayKey = (t) => istParts(new Date(t * 1000)).dateKey;

/**
 * The simulation params for a set of settings, on top of the user's fixed ones (lot size, anti-chase, already-moved, with-the-day...).
 * @param {Record<string, any>} base
 * @param {Settings} s
 * @param {number} budget
 */
export function paramsFor(base, s, budget) {
  return {
    ...base,
    combos: s.combos,
    maxTrades: s.maxTrades,
    dailyLoss: (budget * s.dailyLossPct) / 100,
    lossLimit: s.lossLimit,
    lossStreak: s.lossStreak,
    steps: s.steps,
    stopRule: s.stopRule,
    trail: s.trail,
    breakEven: s.breakEven,
    entryFrom: s.entryFrom,
    entryTo: s.entryTo,
    live: true,
  };
}

/**
 * @param {{ nifty1: any[], stocks5?: Record<string, any[]> | null, book?: any, params: Record<string, any>, days: string[], budget: number }} o
 *   nifty1: index 1-minute candles, oldest first, a few days longer than `days` so the indicators have context
 *   book: the saved real premiums (study/priceBook.js), or null
 *   days: the day keys (YYYY-MM-DD) the trades count on
 */
export function learnContext({ nifty1, stocks5 = null, book = null, params, days, budget, botSignalsFn = botSignals }) {
  const last = [...days].sort().at(-1);
  const complete = nifty1.filter((b) => dayKey(b.time) <= /** @type {string} */ (last));
  const daySet = new Set(days);
  const byTime = new Map(complete.map((b, i) => [b.time, i]));
  let bars5 = aggregateCandles(complete, '5m');
  if (bars5.length && bars5.at(-1).time + 300 > complete.at(-1).time + 60) bars5 = bars5.slice(0, -1);
  const breadth = breadthSeries(bars5, stocks5);
  const flow = turnoverSeries(bars5, stocks5);
  const prep = prepare(bars5, breadth, flow);
  const options = book ? optionSeries(bars5, book, { strikeStep: params.strikeStep }) : null;
  const chart = buildChart(bars5, /** @type {any} */ ({ breadth, flow, prep, options }));
  const inDays = (/** @type {{ time: number }} */ s) => daySet.has(dayKey(s.time - 300));
  /** @type {Map<string, any[]>} */
  const cache = new Map();
  const comboMin = Number(params.comboMinScore) || 0;
  const patternMin = Number(params.patternMinScore) || 0;
  const scoreOn = params.scoreEntries === true;
  // the live chart score at each 5-minute close (and the score entries), worked out once per run: it does not depend on what Learn changes
  /** @type {Promise<{ signals: any[], scores: Map<number, { CE: number, PE: number }> }> | null} */
  let bot = null;
  const botOf = () => {
    if (!bot) {
      const first = [...days].sort()[0];
      const fromTime = complete.find((b) => dayKey(b.time) >= first)?.time ?? Infinity;
      bot = botSignalsFn({ prep, c1: complete, byTime, breadth, fromTime, daily: dailyFrom(complete), minScore: scoreOn ? Number(params.scoreMin ?? 70) : 101 });
    }
    return bot;
  };
  const needsBot = scoreOn || comboMin > 0 || patternMin > 0;
  /** Keeps a signal only while its side's chart score is at least `min` at that close, as live. */
  const scored = (/** @type {any[]} */ list, /** @type {number} */ min, /** @type {Map<number, any>} */ scores) =>
    min > 0 ? list.map((x) => (x.score != null ? x : { ...x, score: scores.get(x.i)?.[x.side] })).filter((x) => x.score != null && x.score >= min) : list;
  const windowOf = (/** @type {Settings} */ s) => entryTest({ from: s.entryFrom, to: s.entryTo });
  const comboKey = (/** @type {any} */ c, /** @type {Settings} */ s) => JSON.stringify([c.id, c.conds, c.also ?? [], c.need, c.window, c.side ?? null, c.stopMode ?? null, c.stopAtr ?? null, c.stopPoints ?? null, s.entryFrom, s.entryTo]);
  const signalsOf = async (/** @type {Settings} */ s) => {
    const scores = needsBot ? (await botOf()).scores : new Map();
    const out = [];
    for (const c of s.combos.filter((x) => x.on !== false)) {
      const key = comboKey(c, s);
      // the signals do not depend on the exits, so they are found once and a combination's own exits are put on them each time
      if (!cache.has(key)) cache.set(key, scored(comboSignals(chart, { ...c, exits: undefined, bot: undefined }, /** @type {any} */ ({ when: windowOf(s), label: `combo:${c.id}` })).filter(inDays), comboMin, scores));
      const found = /** @type {any[]} */ (cache.get(key));
      const exits = comboExits(c);
      const bot = activeBot(c); // bot-calculated stop and targets in place of the ladder (combos/bot.js)
      out.push(...(exits || bot ? found.map((x) => ({ ...x, ...(exits ? { exits } : {}), ...(bot ? { bot } : {}) })) : found));
    }
    if (s.patternEntries && s.patterns.length) {
      const key = JSON.stringify(['patterns', [...s.patterns].sort(), s.entryFrom, s.entryTo]);
      if (!cache.has(key)) cache.set(key, scored(findSignals(prep, /** @type {any} */ ({ when: windowOf(s), only: s.patterns })).filter(inDays), patternMin, scores));
      out.push(.../** @type {any[]} */ (cache.get(key)));
    }
    if (scoreOn && /** @type {any} */ (s).scoreEntries !== false) {
      const key = JSON.stringify(['score', s.entryFrom, s.entryTo]);
      if (!cache.has(key)) {
        const when = windowOf(s);
        cache.set(key, (await botOf()).signals.filter((x) => inDays(x) && (when ? when(x.time - 300) : true)).map((x) => ({ ...x, technique: 'score' })));
      }
      out.push(.../** @type {any[]} */ (cache.get(key)));
    }
    return out;
  };
  return {
    chart,
    hasOptions: Boolean(options),
    /** Works out the chart score at every 5-minute close now (the slow part, once per run), so the first change tried is not slow. */
    warm: async () => {
      if (needsBot) await botOf();
    },
    optionDays: options?.days ?? 0,
    usable: (/** @type {string} */ k) => Boolean(CONDITION_BY_KEY.has(k) && usable(CONDITION_BY_KEY.get(k), chart.have)),
    /** @param {Settings} s */
    evaluate: async (s) => {
      const { trades } = tradesFor(await signalsOf(s), { c1: complete, byTime, params: paramsFor(params, s, budget) });
      await new Promise((resolve) => setImmediate(resolve));
      return /** @type {any[]} */ (trades);
    },
  };
}
