import { z } from 'zod';
import { CONDITION_BY_KEY, holds, usable, buildChart, BUFFER_ATR } from './conditions.js';
import { istParts } from '../market/marketHours.js';
import { FIRST_ENTRY_MIN, LAST_ENTRY_MIN } from '../options/signal.js';

// A combination is a short list of conditions picked by the user, and how many of them must hold together for a trade:
// { id, name, conds: [condition keys], need: how many of them (all by default), window: how many bars an "event" condition stays true }.
// It gives a signal on the first bar where enough of them hold, then waits for it to stop holding (or 3 bars) before it can give another.

export const MAX_CONDITIONS = 20;
export const MAX_COMBOS = 30; // saved combinations per user, for options and for shares each
export const DEFAULT_WINDOW = 3;
export const MAX_ALSO = 6; // add-on checks on top of an "any N of M" rule
const COOLDOWN_BARS = 3;
const STOP_LOOKBACK = 6; // with no pattern in the combination, the stop sits under the last 6 bars, like the Breakout pattern
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** What the settings routes accept; `normalizeCombos` then drops unknown conditions. */
export const comboInput = z
  .array(z.object({ id: z.string().max(60).optional(), name: z.string().max(60).optional(), conds: z.array(z.string().max(40)).max(20), also: z.array(z.string().max(40)).max(6).nullish(), need: z.coerce.number().optional(), window: z.coerce.number().optional(), on: z.boolean().optional(), benchedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), side: z.enum(['CE', 'PE']).nullish(), stopMode: z.enum(['chart', 'cap', 'atr', 'fixed']).nullish(), stopAtr: z.coerce.number().min(0.8).max(2.5).optional(), stopPoints: z.coerce.number().min(10).max(150).optional(), exits: z.object({ steps: z.array(z.object({ at: z.coerce.number(), keep: z.coerce.number() })).max(12).optional(), trail: z.object({ points: z.coerce.number(), start: z.coerce.number().optional() }).nullish(), breakEven: z.coerce.number().min(0).max(150).optional() }).nullish(), order: z.object({ risk: z.coerce.number().min(0).max(1_000_000).optional(), maxAmount: z.coerce.number().min(0).max(100_000_000).optional(), stopPct: z.coerce.number().min(0).max(10).optional(), target: z.coerce.number().min(0).max(10_000_000).optional(), exitMin: z.coerce.number().min(0).max(24 * 60).optional() }).nullish() }))
  .max(MAX_COMBOS);

/** Clean a combination from user input: known conditions only, no repeats, at most MAX_CONDITIONS, `need` between 1 and the count. */
export function normalizeCombo(raw, index = 0) {
  const conds = [...new Set((raw?.conds || []).filter((k) => CONDITION_BY_KEY.has(k)))].slice(0, MAX_CONDITIONS);
  if (!conds.length) return null;
  const name = String(raw.name || '').trim().slice(0, 60) || `Combination ${index + 1}`;
  const need = Math.min(conds.length, Math.max(1, Math.round(Number(raw.need)) || conds.length));
  const window = Math.min(6, Math.max(1, Math.round(Number(raw.window)) || DEFAULT_WINDOW));
  const out = { id: slug(raw.id || name) || `combo-${index + 1}`, name, conds, need, window, on: raw.on !== false && raw.index !== 'SENSEX' }; // a combination that was Sensex-only is kept but switched off
  // add-on checks that must all hold beside the rule; only used when the rule is "any N of M" (for "all" they simply join `conds`)
  const also = [...new Set((raw.also || []).filter((k) => CONDITION_BY_KEY.has(k) && !conds.includes(k)))].slice(0, MAX_ALSO);
  if (also.length && need < conds.length) out.also = also;
  else if (also.length) {
    out.conds = [...conds, ...also].slice(0, MAX_CONDITIONS);
    out.need = out.conds.length;
  }
  if (out.on === false && typeof raw.benchedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.benchedOn)) out.benchedOn = raw.benchedOn; // switched off by the bench; gone once it is on again
  if (raw.side === 'CE' || raw.side === 'PE') out.side = raw.side; // unset = both: a call on the rise and a put on the fall. One side only stops a "bullish" combination from buying puts.
  // an optional stop of its own: the combination's entries use it in place of the stop set for every entry in Account > Entries
  if (STOP_MODES.includes(raw.stopMode)) {
    out.stopMode = raw.stopMode;
    out.stopAtr = Math.min(2.5, Math.max(0.8, Number(raw.stopAtr) || 2));
    out.stopPoints = Math.min(150, Math.max(10, Math.round(Number(raw.stopPoints)) || 30));
  }
  const exits = normalizeExits(raw.exits);
  if (exits) out.exits = exits;
  const order = normalizeOrder(raw.order);
  if (order) out.order = order;
  return out;
}

export const ORDER_LIMITS = { risk: [50, 1_000_000], maxAmount: [1000, 100_000_000], stopPct: [0.3, 5], target: [50, 10_000_000], exitMin: [9 * 60 + 30, 15 * 60 + 15] };

/**
 * A share combination's own order settings, each optional (0 or missing = the Account one): `risk` (rupees lost at the stop, sizes the trade),
 * `maxAmount` (most money put in one trade), `stopPct` (stop this % from the entry in place of the chart stop), `target` (sell at this rupee
 * profit in place of the profit ladder) and `exitMin` (minute of the day, IST, its trades are closed and no new one is taken). Returns undefined when nothing is set.
 */
export function normalizeOrder(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(ORDER_LIMITS)) {
    const v = Number(raw[k]);
    if (!(v > 0)) continue;
    out[k] = k === 'stopPct' ? Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100 : Math.round(Math.min(hi, Math.max(lo, v)));
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A combination's own exits, each optional: `steps` (the profit ladder, [] for none), `trail` ({ points, start } or null for none) and
 * `breakEven` (points, 0 for none). A part that is left out uses the shared setting of Account > Limits and Entries. Returns undefined when nothing is set.
 */
export function normalizeExits(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  if (Array.isArray(raw.steps)) {
    const steps = raw.steps.map((r) => ({ at: Math.round(Number(r?.at)), keep: Math.round(Number(r?.keep)) }));
    const ok = steps.length <= 12 && steps.every((r, i) => r.keep > 0 && r.at > r.keep && (i === 0 || (r.at > steps[i - 1].at && r.keep > steps[i - 1].keep)));
    if (ok) out.steps = steps;
  }
  if (raw.trail === null) out.trail = null;
  else if (raw.trail && Number(raw.trail.points) >= 5) {
    const points = Math.min(150, Math.round(Number(raw.trail.points)));
    out.trail = { points, start: Math.min(300, Math.max(5, Math.round(Number(raw.trail.start)) || points)) };
  }
  if (raw.breakEven !== undefined && raw.breakEven !== null) {
    const be = Math.round(Number(raw.breakEven));
    if (be === 0 || (be >= 5 && be <= 150)) out.breakEven = be;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The exits a combination sets for itself (see normalizeExits), or undefined when it uses the shared ones. */
export const comboExits = (combo) => normalizeExits(combo?.exits);

const STOP_MODES = ['chart', 'cap', 'atr', 'fixed'];

/** The stop rule of a combination's own (see ruleStop), or null when it uses the shared one. */
export const comboStopRule = (combo) => (STOP_MODES.includes(combo?.stopMode) ? { mode: combo.stopMode, k: combo.stopAtr ?? 2, points: combo.stopPoints ?? 30 } : null);

export const normalizeCombos = (list) => {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).slice(0, MAX_COMBOS).forEach((raw, i) => {
    const c = normalizeCombo(raw, i);
    if (!c) return;
    let id = c.id;
    for (let n = 2; seen.has(id); n++) id = `${c.id}-${n}`;
    seen.add(id);
    out.push({ ...c, id });
  });
  return out;
};

/** The conditions of a combination that the chart has the data for; a combination that needs data the chart lacks cannot be tested. */
export const missingData = (combo, have) => [...combo.conds, ...(combo.also || [])].map((k) => CONDITION_BY_KEY.get(k)).filter((c) => !usable(c, have)).map((c) => c.needs);

/** Does a combination apply to this index? One with no index of its own is for both. */
export const comboFitsIndex = (combo, index) => !combo.index || !index || combo.index === index;

const tradeableIndex = (time) => {
  const { minutes } = istParts(new Date((time + 300) * 1000));
  return minutes >= FIRST_ENTRY_MIN && minutes < LAST_ENTRY_MIN;
};

const HELD = new WeakMap(); // chart -> Map(`${cond}|${d}|${window}` -> Uint8Array)

/** For every bar, whether `cond` holds there (a state) or held on one of the last `window` bars (an event). Made once per chart, so trying many combinations only adds up arrays. */
function heldArray(chart, cond, d, window) {
  let cache = HELD.get(chart);
  if (!cache) HELD.set(chart, (cache = new Map()));
  const key = `${cond.key}|${d}|${cond.kind === 'state' ? 0 : window}`;
  let arr = cache.get(key);
  if (arr) return arr;
  const n = chart.bars.length;
  holds(chart, cond, d, 0); // fills the per-chart truth array
  const truth = chart.truths.get(`${cond.key}|${d}`);
  if (cond.kind === 'state') arr = truth;
  else {
    arr = new Uint8Array(n);
    let last = -Infinity; // the latest bar on which it held
    for (let i = 0; i < n; i++) {
      if (truth[i]) last = i;
      arr[i] = i - last < window ? 1 : 0;
    }
  }
  cache.set(key, arr);
  return arr;
}

/**
 * The signals a combination gives over the chart, shaped like the pattern signals: { technique, side, i, time, close, stop, note, atr }.
 * @param label   name used as `technique` and in the note
 * @param opts    from: first bar to look at; windows: only inside the options entry hours; when: (time) => boolean for any other entry hours
 */
export function comboSignals(chart, combo, { from = 15, windows = true, when = null, label = null } = {}) {
  const conds = combo.conds.map((k) => CONDITION_BY_KEY.get(k)).filter(Boolean);
  if (!conds.length || conds.some((c) => !usable(c, chart.have))) return [];
  if ((combo.also || []).some((k) => CONDITION_BY_KEY.has(k) && !usable(CONDITION_BY_KEY.get(k), chart.have))) return [];
  const need = Math.min(combo.need || conds.length, conds.length);
  const window = combo.window || DEFAULT_WINDOW;
  const out = [];
  const stopRule = comboStopRule(combo);
  const exits = comboExits(combo);
  for (const d of [1, -1]) {
    if (combo.side && (combo.side === 'CE') !== (d > 0)) continue; // a combination locked to calls (or puts) gives no signal on the other side
    const view = chart.views[d];
    const arrs = conds.map((c) => heldArray(chart, c, d, window));
    const also = (combo.also || []).map((k) => CONDITION_BY_KEY.get(k)).filter(Boolean).map((c) => heldArray(chart, c, d, window)); // extra checks that must all hold on top of the rule
    const score = (i) => {
      let n = 0;
      for (const a of arrs) n += a[i];
      return n;
    };
    let lastFire = -99;
    let before = from > 0 ? score(from - 1) >= need : false;
    for (let i = Math.max(from, 1); i < chart.bars.length; i++) {
      const now = score(i) >= need && also.every((a) => a[i]);
      const fresh = now && !before;
      before = now;
      const a = chart.atr[i];
      if (!fresh || !a || i - lastFire <= COOLDOWN_BARS) continue;
      const bar = chart.bars[i];
      if (when ? !when(bar.time) : windows && !tradeableIndex(bar.time)) continue;
      lastFire = i;
      // The stop: the nearest chart level of the patterns in the combination that fired within the window, else the last 6 bars.
      const stops = [];
      for (const cond of conds) {
        if (!cond.pattern) continue;
        for (let k = Math.max(0, i - window + 1); k <= i; k++) {
          const sig = chart.patterns[d].get(cond.pattern)?.get(k);
          if (sig) stops.push(d > 0 ? sig.stop : -sig.stop);
        }
      }
      let stop;
      if (stops.length) stop = Math.max(...stops); // in the mirrored view every stop is below the price, so the nearest is the highest
      else stop = Math.min(...view.L.slice(Math.max(0, i - STOP_LOOKBACK + 1), i + 1)) - BUFFER_ATR * a;
      out.push({
        technique: label || combo.id,
        side: d > 0 ? 'CE' : 'PE',
        i,
        time: bar.time + 300,
        close: bar.close,
        stop: d > 0 ? stop : -stop,
        note: combo.conds.map((k) => CONDITION_BY_KEY.get(k).label).join(' + '),
        atr: a,
        ...(stopRule ? { stopRule } : {}),
        ...(exits ? { exits } : {}),
      });
    }
  }
  return out.sort((x, y) => x.i - y.i);
}

/** Whether one check held on bar i of the chart, as a call (d = 1) or a put (d = -1): a state on the bar, an event anywhere in the last `window` bars. */
export function holdsAt(chart, key, d, i, window = DEFAULT_WINDOW) {
  const cond = CONDITION_BY_KEY.get(key);
  return Boolean(cond && usable(cond, chart.have) && heldArray(chart, cond, d, window)[i]);
}

/** Which checks of a combination held on bar i of the chart, as a call (d = 1) or a put (d = -1): a state on the bar, an event anywhere in the last `window` bars. */
export function heldConditions(chart, combo, d, i) {
  const window = combo.window || DEFAULT_WINDOW;
  return [...combo.conds, ...(combo.also || [])]
    .map((k) => CONDITION_BY_KEY.get(k))
    .filter(Boolean)
    .map((cond) => {
      let held = false;
      if (cond.kind === 'state') held = holds(chart, cond, d, i);
      else for (let k = Math.max(0, i - window + 1); k <= i && !held; k++) held = holds(chart, cond, d, k);
      return { key: cond.key, label: cond.label, text: cond.text, held };
    });
}

/** One line saying what a combination needs, for the study table and the log. */
export function describeCombo(combo) {
  const names = combo.conds.map((k) => CONDITION_BY_KEY.get(k)?.label || k);
  const rule = combo.need >= combo.conds.length ? `All ${names.length} must hold together` : `At least ${combo.need} of ${names.length} must hold together`;
  const extra = (combo.also || []).map((k) => CONDITION_BY_KEY.get(k)?.label || k);
  const events = [...combo.conds, ...(combo.also || [])].some((k) => CONDITION_BY_KEY.get(k)?.kind === 'event') ? `; an event (a cross, a break, a pattern) counts for ${combo.window} bars` : '';
  return `${rule}${events}: ${names.join(', ')}${extra.length ? `; and ${extra.length === 1 ? 'this must' : 'these must all'} hold too: ${extra.join(', ')}` : ''}. The trade is taken on the first bar where that is true. Stop at the nearest pattern level in it, else under the last ${STOP_LOOKBACK} bars.`;
}

/** A single condition, as a one-condition combination: it gives a signal each time it turns true. For ranking conditions. */
export const singleCombo = (key) => ({ id: `c_${key}`, name: CONDITION_BY_KEY.get(key).label, conds: [key], need: 1, window: 1 });

export { buildChart };
