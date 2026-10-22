import { roundToTick, round2 } from '../utils/money.js';
import { levelName } from './levels.js';

// Each setup looks at one stock and returns zero or more candidate ideas:
//   { setup, side, status, trigger, entry, entryLow, entryHigh, stopLoss, stopNote,
//     target1, target2, targetNote, riskReward, reasons, wrongIf }
// status: ENTRY (trigger fired, still in the entry zone), WATCHING (setup forming) or
// MISSED (trigger fired but price already ran too far to chase).

export const MIN_RISK_REWARD = 1.5;
const MIN_RISK_PCT = 0.003; // a stop tighter than this is hit by normal noise
const CHASE_ATR = 0.75; // how far past the trigger still counts as "in the zone"

const fmt = (n) => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sides = [
  { side: 'BUY', d: 1 },
  { side: 'SELL', d: -1 },
];
const word = (d) => (d > 0 ? { above: 'above', below: 'below', up: 'up', high: 'high', low: 'low' } : { above: 'below', below: 'above', up: 'down', high: 'low', low: 'high' });

/** Nearest levels ahead of `entry` become targets; with none in view, fall back to multiples of risk. */
function pickTargets(ctx, d, entry, risk) {
  const buffer = ctx.atr5 * 0.1;
  const ahead = ctx.levels.filter((l) => d * (l.price - entry) >= ctx.atr5 * 0.5).sort((a, b) => d * (a.price - b.price));
  const first = ahead[0];
  const target1 = first ? first.price - d * buffer : entry + d * 2 * risk;
  const second = ahead.find((l) => d * (l.price - target1) >= ctx.atr5 * 0.5);
  const target2 = second ? second.price - d * buffer : target1 + d * risk;
  return {
    target1: roundToTick(target1),
    target2: roundToTick(target2),
    targetNote: first ? `just before ${levelName(first.kind)} ${fmt(first.price)}` : 'twice the risk (no level in view)',
  };
}

/**
 * Turn an entry price and a raw stop into a full plan, or null when the reward is not worth the risk.
 * `projection` overrides the target (used by the opening range breakout).
 */
function makePlan(ctx, d, entry, rawStop, stopNote, projection) {
  const minRisk = Math.max(entry * MIN_RISK_PCT, ctx.atr5 * 0.5);
  const risk = Math.max(Math.abs(entry - rawStop), minRisk);
  const stopLoss = roundToTick(entry - d * risk);
  const t = projection
    ? { target1: roundToTick(entry + d * projection), target2: roundToTick(entry + d * 2 * projection), targetNote: 'the opening range height projected from the breakout' }
    : pickTargets(ctx, d, entry, risk);
  const riskReward = round2(Math.abs(t.target1 - entry) / risk);
  if (riskReward < MIN_RISK_REWARD) return null;
  return { stopLoss, stopNote, ...t, riskReward };
}

function zone(d, ref, atr5) {
  const far = roundToTick(ref + d * atr5 * CHASE_ATR);
  return d > 0 ? { entryLow: roundToTick(ref), entryHigh: far } : { entryLow: far, entryHigh: roundToTick(ref) };
}

function candidate(ctx, { setup, side, d, status, trigger, entry, rawStop, stopNote, projection, reasons, wrongIf }) {
  const plan = makePlan(ctx, d, entry, rawStop, stopNote, projection);
  if (!plan) return null;
  return { setup, side, status, trigger: roundToTick(trigger), entry: roundToTick(entry), ...zone(d, entry, ctx.atr5), ...plan, reasons, wrongIf };
}

/** Break of the first 15 minutes' high or low. Becomes "Gap and go" when the stock also gapped that way and held it. */
export function openingRange(ctx) {
  const { or, c5, ltp, atr5 } = ctx;
  if (!or) return [];
  const range = or.high - or.low;
  if (range <= 0 || range / ltp > 0.02 || range < atr5 * 0.4) return [];
  const done = c5.at(-2);
  if (!done) return [];
  const mid = (or.high + or.low) / 2;
  const out = [];
  for (const { side, d } of sides) {
    const level = d > 0 ? or.high : or.low;
    const confirmed = d * (done.close - level) > 0;
    const beyond = d * (ltp - level);
    let status;
    if (confirmed && beyond > 0) status = beyond <= atr5 * CHASE_ATR ? 'ENTRY' : 'MISSED';
    else if (!confirmed && beyond > -atr5 * 0.5) status = 'WATCHING';
    else continue;

    // A gap counts as "held" when the opening range stayed on the gap side of the halfway point back to yesterday's close.
    const halfway = ctx.prevClose + (ctx.tick.open - ctx.prevClose) / 2;
    const gapHeld = Boolean(ctx.prevClose) && d * ctx.gapPct >= 0.7 && d * ((d > 0 ? or.low : or.high) - halfway) > 0;
    const w = word(d);
    const entry = status === 'WATCHING' ? level : ltp;
    const c = candidate(ctx, {
      setup: gapHeld ? 'Gap and go' : 'Opening range breakout',
      side,
      d,
      status,
      trigger: level,
      entry,
      rawStop: mid,
      stopNote: `the middle of the opening range (${fmt(mid)})`,
      projection: range,
      reasons: [
        `The first 15 minutes ranged ${fmt(or.low)} to ${fmt(or.high)}`,
        confirmed ? `A 5-minute bar closed ${w.above} the range ${w.high}` : `Waiting for a 5-minute close ${w.above} ${fmt(level)}`,
        ...(gapHeld ? [`The stock gapped ${w.up} ${Math.abs(ctx.gapPct).toFixed(1)}% and has held the gap`] : []),
      ],
      wrongIf: `A 5-minute close back inside the range, ${w.below} ${fmt(level)}`,
    });
    if (c) out.push(c);
  }
  return out;
}

/** A stock in a trend dips back to VWAP and bounces. */
export function vwapPullback(ctx) {
  const { vwap, c5, today5, ltp, atr5 } = ctx;
  if (!vwap || today5.length < 12) return [];
  const done = c5.at(-2);
  const recent = c5.slice(-8, -1);
  const earlier = today5.slice(0, -8);
  const out = [];
  for (const { side, d } of sides) {
    if (d * ctx.trend5 <= 0 || d * ctx.trend15 < 0) continue;
    const wasAway = earlier.some((b) => d * (b.close - vwap) > atr5 * 0.5);
    const touched = recent.some((b) => (d > 0 ? b.low <= vwap + atr5 * 0.1 : b.high >= vwap - atr5 * 0.1));
    const away = d * (ltp - vwap);
    if (!wasAway || !touched || away < 0) continue;
    const confirmed = d * (done.close - done.open) > 0 && d * (done.close - vwap) > 0;
    let status;
    if (confirmed) status = away <= atr5 * 1.2 ? 'ENTRY' : 'MISSED';
    else if (away <= atr5 * 0.6) status = 'WATCHING';
    else continue;

    const triggerPrice = d > 0 ? done.high : done.low;
    const entry = status === 'WATCHING' ? triggerPrice : ltp;
    const tail = c5.slice(-4, -1);
    const rawStop = d > 0 ? Math.min(...tail.map((b) => b.low), vwap) - atr5 * 0.15 : Math.max(...tail.map((b) => b.high), vwap) + atr5 * 0.15;
    const w = word(d);
    const c = candidate(ctx, {
      setup: 'VWAP pullback',
      side,
      d,
      status,
      trigger: triggerPrice,
      entry,
      rawStop,
      stopNote: `just past the pullback ${w.low} and VWAP (${fmt(vwap)})`,
      reasons: [
        `The ${w.up}trend is intact: EMA 9 is ${w.above} EMA 21 on 5-minute bars`,
        `Price pulled back to VWAP (${fmt(vwap)}) and is holding ${w.above} it`,
        confirmed ? `The last 5-minute bar closed ${d > 0 ? 'green' : 'red'} ${w.above} VWAP` : `Waiting for a ${d > 0 ? 'green' : 'red'} 5-minute close ${w.above} VWAP`,
      ],
      wrongIf: `A 5-minute close ${w.below} VWAP (${fmt(vwap)})`,
    });
    if (c) out.push(c);
  }
  return out;
}

/** A broken swing level is retested from the other side and holds. */
export function levelRetest(ctx) {
  const { levels, c5, ltp, atr5 } = ctx;
  const win = c5.slice(-17, -1);
  const before = c5.slice(-40, -1);
  const done = c5.at(-2);
  const tail = c5.slice(-4, -1);
  const out = [];
  for (const { side, d } of sides) {
    // The nearest level that price has recently broken through and is now back at.
    const near = levels
      .filter((l) => l.kind !== 'VWAP' && d * (ltp - l.price) >= -atr5 * 0.1 && d * (ltp - l.price) <= atr5 * 1.5)
      .sort((a, b) => d * (b.price - a.price));
    for (const l of near) {
      const brokeOut = win.some((b, i) => d * (b.close - l.price) > atr5 * 0.2 && before.slice(0, before.length - win.length + i).some((p) => d * (p.close - l.price) < -atr5 * 0.2));
      const touched = tail.some((b) => d * ((d > 0 ? b.low : b.high) - l.price) <= atr5 * 0.25);
      if (!brokeOut || !touched) continue;
      const away = d * (ltp - l.price);
      const confirmed = d * (done.close - done.open) > 0 && d * (done.close - l.price) > 0;
      let status;
      if (confirmed) status = away <= atr5 * 1.0 ? 'ENTRY' : 'MISSED';
      else if (away <= atr5 * 0.5) status = 'WATCHING';
      else continue;
      const w = word(d);
      const triggerPrice = d > 0 ? done.high : done.low;
      const entry = status === 'WATCHING' ? triggerPrice : ltp;
      const rawStop = (d > 0 ? Math.min(...tail.map((b) => b.low), l.price) : Math.max(...tail.map((b) => b.high), l.price)) - d * atr5 * 0.2;
      const c = candidate(ctx, {
        setup: 'Level retest',
        side,
        d,
        status,
        trigger: triggerPrice,
        entry,
        rawStop,
        stopNote: `just past ${levelName(l.kind)} ${fmt(l.price)}`,
        reasons: [
          `Price broke ${w.above} ${levelName(l.kind)} (${fmt(l.price)})`,
          `It came back to test that level and held it`,
          confirmed ? `The last 5-minute bar closed ${d > 0 ? 'green' : 'red'} ${w.above} it` : `Waiting for a ${d > 0 ? 'green' : 'red'} 5-minute close ${w.above} it`,
        ],
        wrongIf: `A 5-minute close back ${w.below} ${fmt(l.price)}`,
      });
      if (c) out.push(c);
      break; // one level per side
    }
  }
  return out;
}

export const SETUPS = [openingRange, vwapPullback, levelRetest];
