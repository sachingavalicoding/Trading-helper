// @ts-check
import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { prepare, findSignals, turnoverSeries } from '../study/patterns.js';
import { breadthSeries, tradesFor } from '../study/optionsStudy.js';
import { buildChart, usable, CONDITION_BY_KEY } from '../combos/conditions.js';
import { comboSignals } from '../combos/combos.js';
import { optionSeries } from '../combos/optionData.js';
import { entryTest } from '../options/signal.js';

// The replay Lab > Learn judges settings with: the index chart of the saved days built once (with the option-chain series where real
// prices were saved), and for any settings the trades the live rules would have made (study/optionsStudy.js tradesFor: one call and
// one put at a time, the pauses, the trades a day, the daily loss limit, the stop sizing the lots, the profit ladder, real premiums).

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
export function learnContext({ nifty1, stocks5 = null, book = null, params, days, budget }) {
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
  const windowOf = (/** @type {Settings} */ s) => entryTest({ from: s.entryFrom, to: s.entryTo });
  const comboKey = (/** @type {any} */ c, /** @type {Settings} */ s) => JSON.stringify([c.id, c.conds, c.also ?? [], c.need, c.window, c.side ?? null, c.stopMode ?? null, c.stopAtr ?? null, c.stopPoints ?? null, c.exits ?? null, s.entryFrom, s.entryTo]);
  const signalsOf = (/** @type {Settings} */ s) => {
    const out = [];
    for (const c of s.combos.filter((x) => x.on !== false)) {
      const key = comboKey(c, s);
      if (!cache.has(key)) cache.set(key, comboSignals(chart, c, /** @type {any} */ ({ when: windowOf(s), label: `combo:${c.id}` })).filter(inDays));
      out.push(.../** @type {any[]} */ (cache.get(key)));
    }
    if (s.patternEntries && s.patterns.length) {
      const key = JSON.stringify(['patterns', [...s.patterns].sort(), s.entryFrom, s.entryTo]);
      if (!cache.has(key)) cache.set(key, findSignals(prep, /** @type {any} */ ({ when: windowOf(s), only: s.patterns })).filter(inDays));
      out.push(.../** @type {any[]} */ (cache.get(key)));
    }
    return out;
  };
  return {
    chart,
    hasOptions: Boolean(options),
    optionDays: options?.days ?? 0,
    usable: (/** @type {string} */ k) => Boolean(CONDITION_BY_KEY.has(k) && usable(CONDITION_BY_KEY.get(k), chart.have)),
    /** @param {Settings} s */
    evaluate: async (s) => {
      const { trades } = tradesFor(signalsOf(s), { c1: complete, byTime, params: paramsFor(params, s, budget) });
      await new Promise((resolve) => setImmediate(resolve));
      return /** @type {any[]} */ (trades);
    },
  };
}
