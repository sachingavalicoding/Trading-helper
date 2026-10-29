import { summarize } from './simulate.js';
import { halvesOf, verdictOf } from '../combos/verdict.js';

// Research on the exits: the same entries traded again and again with other stop amounts, profit ladders and trailing stops, so the numbers
// the live trader uses can be picked from data. Only one thing changes in each row; everything else stays as set in Account.

export const LOSS_LIMITS = [1000, 1500, 2000, 2500, 3000];
export const TARGETS = [600, 800, 1000, 1500, 2000]; // rupees per lot
export const TRAIL_POINTS = [15, 20, 25, 30, 40, 50];
export const BREAK_EVEN_POINTS = [10, 15, 20, 30];
const ladder = (rows) => rows.map(([at, keep]) => ({ at, keep }));
export const LADDERS = [
  { key: 'early', label: 'Early lock, 6 steps', text: 'Locks from +₹500 and follows close behind: +500 keeps 300, +800 keeps 550, +1,100 keeps 850, +1,400 keeps 1,150, +1,800 keeps 1,500, +2,200 keeps 1,950.', steps: ladder([[500, 300], [800, 550], [1100, 850], [1400, 1150], [1800, 1500], [2200, 1950]]) },
  { key: 'tight', label: 'Tight follow, 6 steps', text: 'Starts at +₹1,000 and stays 150 behind: +1,000 keeps 850, +1,300 keeps 1,150, +1,600 keeps 1,450, +2,000 keeps 1,850, +2,500 keeps 2,350, +3,000 keeps 2,850.', steps: ladder([[1000, 850], [1300, 1150], [1600, 1450], [2000, 1850], [2500, 2350], [3000, 2850]]) },
  { key: 'wide', label: 'Wide room, 6 steps', text: 'Lets the trade breathe, about 400 behind: +1,200 keeps 800, +1,600 keeps 1,200, +2,000 keeps 1,600, +2,500 keeps 2,100, +3,000 keeps 2,600, +3,500 keeps 3,100.', steps: ladder([[1200, 800], [1600, 1200], [2000, 1600], [2500, 2100], [3000, 2600], [3500, 3100]]) },
];
const MIN_TRAIN = 10;

const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

/** The rows to try, as `{ key, group, label, text, set (what changes in params), apply (what a tap on Apply would save, or null when the live trader has no such setting) }`. */
export function variants(params) {
  const yours = Array.isArray(params.steps) ? params.steps : [];
  const out = [];
  for (const lossLimit of LOSS_LIMITS) {
    out.push({ key: `loss${lossLimit}`, group: 'stop', label: `Most one trade may lose: ${rs(lossLimit)}`, text: `The same entries and exits, but lots are sized so the loss at the stop stays within ${rs(lossLimit)} (up to ${params.maxLots} lots).`, set: { lossLimit }, apply: { lossLimit }, current: lossLimit === params.lossLimit });
  }
  out.push({ key: 'ladder-yours', group: 'ladder', label: 'Your ladder as it is', text: yours.length ? `${yours.length} steps from Account > Limits.` : 'Your current profit lock.', set: {}, apply: null, current: true });
  if (yours.length > 6) out.push({ key: 'ladder-yours6', group: 'ladder', label: `Your ladder, top ${yours.length - 6} steps dropped`, text: `Only the first 6 of your ${yours.length} steps.`, set: { steps: yours.slice(0, 6) }, apply: { steps: yours.slice(0, 6) } });
  for (const l of LADDERS) out.push({ key: `ladder-${l.key}`, group: 'ladder', label: l.label, text: l.text, set: { steps: l.steps }, apply: { steps: l.steps } });
  out.push({ key: 'ladder-none', group: 'ladder', label: 'No profit lock', text: 'Winners are left alone until the stop, the trailing stop or the closing time sells them.', set: { steps: [] }, apply: null });
  for (const t of TARGETS) out.push({ key: `target${t}`, group: 'ladder', label: `Sell at +${rs(t)} a lot`, text: `A fixed target of ${rs(t)} per lot and no profit lock. A study choice only: the live options trader does not sell at a fixed target.`, set: { target: t }, apply: null });
  for (const points of TRAIL_POINTS) {
    out.push({ key: `trail${points}`, group: 'trail', label: `Trail ${points} points, with your ladder`, text: `Once Nifty has moved ${points} points your way, the stop follows ${points} points behind the best price. Your profit ladder stays.${params.trail ? ' This replaces the trailing stop you have set.' : ''}`, set: { trail: { points, start: points } }, apply: { trail: { points, start: points } }, current: params.trail?.points === points && params.trail?.start === points });
  }
  for (const points of [20, 30, 40]) {
    out.push({ key: `trailonly${points}`, group: 'trail', label: `Trail ${points} points, no profit lock`, text: `The trailing stop alone: ${points} points behind the best price once Nifty has moved ${points} points your way, and no profit ladder.`, set: { trail: { points, start: points }, steps: [] }, apply: null });
  }
  for (const points of BREAK_EVEN_POINTS) {
    out.push({ key: `be${points}`, group: 'trail', label: `Break-even after ${points} points`, text: `Once Nifty has moved ${points} points your way the stop moves to your entry price, so the trade can no longer lose on the chart stop. Your ladder stays.`, set: { breakEven: points }, apply: { breakEven: points }, current: params.breakEven === points });
  }
  return out;
}

/**
 * @param signals    the entries every row trades (Breakout + Engulfing)
 * @param tradesFor  (signals, { params }) -> { trades, skippedWide }, the study's own trader
 * @param trainEnd   the first moment of the newest third of the days (null when the run is too short to split)
 */
export async function runResearch({ signals, tradesFor, midTime, trainEnd, params: given, onProgress = () => {}, yieldTurn = () => Promise.resolve() }) {
  const params = { ...given, target: 0 }; // the research always starts from the profit ladder, whatever exit the study screen used
  const run = async (set) => {
    const p = { ...params, ...set };
    if (set.target) p.steps = [];
    const { trades, skippedWide } = tradesFor(signals, { params: p });
    return { trades, skippedWide };
  };
  const describe = (trades) => {
    const m = summarize(trades);
    const halves = halvesOf(trades, midTime);
    const train = trainEnd == null ? null : summarize(trades.filter((t) => t.entryTime < trainEnd));
    const test = trainEnd == null ? null : summarize(trades.filter((t) => t.entryTime >= trainEnd));
    return {
      trades: m.trades,
      winRate: m.winRate,
      net: m.net,
      avgWin: m.avgWin,
      avgLoss: m.avgLoss,
      worst: m.worst,
      maxDrawdown: m.maxDrawdown,
      halves,
      verdict: verdictOf({ trades: m.trades, net: m.net, halves }),
      train: train && { trades: train.trades, net: train.net },
      test: test && { trades: test.trades, net: test.net },
    };
  };

  const base = describe((await run({})).trades);
  const rows = [];
  const list = variants(params);
  for (const [n, v] of list.entries()) {
    if (n % 6 === 0) onProgress(`Research: ${n + 1}/${list.length} exit settings tried`);
    const { trades } = await run(v.set);
    rows.push({ key: v.key, group: v.group, label: v.label, text: v.text, current: Boolean(v.current), apply: v.apply, ...describe(trades) });
    await yieldTurn();
  }

  // the best of each kind is picked on the older two thirds only (and only if it beat your settings there), then the mix is shown on the newest third it never saw
  let mix = null;
  if (trainEnd != null) {
    const pick = (group) => rows.filter((r) => r.group === group && r.apply && r.train?.trades >= MIN_TRAIN && r.train.net > base.train.net).sort((a, b) => b.train.net - a.train.net)[0]; // only a change that beat your settings on the older days
    const parts = ['stop', 'ladder', 'trail'].map(pick).filter(Boolean);
    if (parts.length) {
      const set = Object.assign({}, ...parts.map((r) => variants(params).find((v) => v.key === r.key).set));
      const { trades } = await run(set);
      const whole = describe(trades);
      const apply = Object.assign({}, ...parts.map((r) => r.apply));
      mix = { label: 'Best of each, picked on the older days', text: `${parts.map((r) => r.label).join('; ')}. Each was picked by what it earned on the older days only; the second line shows the newest days it never saw.`, apply, ...whole };
    }
  }
  return {
    entries: 'Breakout + Engulfing, with the chart stop',
    signals: signals.length,
    base: { label: 'Your settings now', ...base },
    rows,
    mix,
    minTrain: MIN_TRAIN,
    split: trainEnd != null,
  };
}
