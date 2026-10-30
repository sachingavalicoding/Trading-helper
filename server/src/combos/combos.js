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
const COOLDOWN_BARS = 3;
const STOP_LOOKBACK = 6; // with no pattern in the combination, the stop sits under the last 6 bars, like the Breakout pattern
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** What the settings routes accept; `normalizeCombos` then drops unknown conditions. */
export const comboInput = z
  .array(z.object({ id: z.string().max(60).optional(), name: z.string().max(60).optional(), conds: z.array(z.string().max(40)).max(20), need: z.coerce.number().optional(), window: z.coerce.number().optional(), on: z.boolean().optional() }))
  .max(MAX_COMBOS);

/** Clean a combination from user input: known conditions only, no repeats, at most MAX_CONDITIONS, `need` between 1 and the count. */
export function normalizeCombo(raw, index = 0) {
  const conds = [...new Set((raw?.conds || []).filter((k) => CONDITION_BY_KEY.has(k)))].slice(0, MAX_CONDITIONS);
  if (!conds.length) return null;
  const name = String(raw.name || '').trim().slice(0, 60) || `Combination ${index + 1}`;
  const need = Math.min(conds.length, Math.max(1, Math.round(Number(raw.need)) || conds.length));
  const window = Math.min(6, Math.max(1, Math.round(Number(raw.window)) || DEFAULT_WINDOW));
  return { id: slug(raw.id || name) || `combo-${index + 1}`, name, conds, need, window, on: raw.on !== false };
}

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
export const missingData = (combo, have) => combo.conds.map((k) => CONDITION_BY_KEY.get(k)).filter((c) => !usable(c, have)).map((c) => c.needs);

const tradeableIndex = (time) => {
  const { minutes } = istParts(new Date((time + 300) * 1000));
  return minutes >= FIRST_ENTRY_MIN && minutes < LAST_ENTRY_MIN;
};

/** How many of the combination's conditions hold on bar i: states on the bar, events anywhere in the last `window` bars. */
function score(chart, conds, d, i, window) {
  let n = 0;
  for (const cond of conds) {
    if (cond.kind === 'state') {
      if (holds(chart, cond, d, i)) n += 1;
    } else {
      for (let k = Math.max(0, i - window + 1); k <= i; k++) {
        if (holds(chart, cond, d, k)) {
          n += 1;
          break;
        }
      }
    }
  }
  return n;
}

/**
 * The signals a combination gives over the chart, shaped like the pattern signals: { technique, side, i, time, close, stop, note, atr }.
 * @param label   name used as `technique` and in the note
 * @param opts    from: first bar to look at; windows: only inside the options entry hours; when: (time) => boolean for any other entry hours
 */
export function comboSignals(chart, combo, { from = 15, windows = true, when = null, label = null } = {}) {
  const conds = combo.conds.map((k) => CONDITION_BY_KEY.get(k)).filter(Boolean);
  if (!conds.length || conds.some((c) => !usable(c, chart.have))) return [];
  const need = Math.min(combo.need || conds.length, conds.length);
  const window = combo.window || DEFAULT_WINDOW;
  const out = [];
  for (const d of [1, -1]) {
    const view = chart.views[d];
    let lastFire = -99;
    let before = from > 0 ? score(chart, conds, d, from - 1, window) >= need : false;
    for (let i = Math.max(from, 1); i < chart.bars.length; i++) {
      const now = score(chart, conds, d, i, window) >= need;
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
      });
    }
  }
  return out.sort((x, y) => x.i - y.i);
}

/** Which checks of a combination held on bar i of the chart, as a call (d = 1) or a put (d = -1): a state on the bar, an event anywhere in the last `window` bars. */
export function heldConditions(chart, combo, d, i) {
  const window = combo.window || DEFAULT_WINDOW;
  return combo.conds
    .map((k) => CONDITION_BY_KEY.get(k))
    .filter(Boolean)
    .map((cond) => {
      let held = false;
      if (cond.kind === 'state') held = holds(chart, cond, d, i);
      else for (let k = Math.max(0, i - window + 1); k <= i && !held; k++) held = holds(chart, cond, d, k);
      return { key: cond.key, label: cond.label, held };
    });
}

/** One line saying what a combination needs, for the study table and the log. */
export function describeCombo(combo) {
  const names = combo.conds.map((k) => CONDITION_BY_KEY.get(k)?.label || k);
  const rule = combo.need >= combo.conds.length ? `All ${names.length} must hold together` : `At least ${combo.need} of ${names.length} must hold together`;
  const events = combo.conds.some((k) => CONDITION_BY_KEY.get(k)?.kind === 'event') ? `; an event (a cross, a break, a pattern) counts for ${combo.window} bars` : '';
  return `${rule}${events}: ${names.join(', ')}. The trade is taken on the first bar where that is true. Stop at the nearest pattern level in it, else under the last ${STOP_LOOKBACK} bars.`;
}

/** A single condition, as a one-condition combination: it gives a signal each time it turns true. For ranking conditions. */
export const singleCombo = (key) => ({ id: `c_${key}`, name: CONDITION_BY_KEY.get(key).label, conds: [key], need: 1, window: 1 });

export { buildChart };
