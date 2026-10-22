import { ema, rsi, macd, atr, sessionVwap, swings } from './indicators.js';
import { roundToTick, round2 } from '../utils/money.js';

// Rule-based intraday read of one stock. Every factor votes +1 (bullish), -1 (bearish) or 0,
// and a trade is only suggested when the trend votes agree and the reward is worth the risk.
// It describes what the chart shows right now; it does not predict the future.

export const MIN_RISK_REWARD = 1.5;
const BUY_SCORE = 4;
const MOOD_PCT = 0.25;
// A stop tighter than this gets hit by normal intraday noise.
const MIN_RISK_PCT = 0.003;

const last = (points) => points.at(-1)?.value ?? null;
const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
// Treat averages within 0.05% of each other as flat, so a sideways chart does not vote.
const trendVote = (fast, slow) => (Math.abs(fast - slow) / slow < 0.0005 ? 0 : sign(fast - slow));
const fmt = (n) => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "Day's high · VWAP" -> "day's high / VWAP" for use mid-sentence.
const levelName = (kind) => kind.split(' · ').map((k) => (k === k.toUpperCase() ? k : k[0].toLowerCase() + k.slice(1))).join(' / ');

function factor(id, label, vote, text) {
  return { id, label, vote, text };
}

/** Nearby price levels, merged when within 0.15% of each other. */
function buildLevels({ ltp, c5, tick, vwap }) {
  const { highs, lows } = swings(c5.slice(-60));
  const raw = [
    ...highs.map((p) => ({ price: p, kind: 'Swing high' })),
    ...lows.map((p) => ({ price: p, kind: 'Swing low' })),
    { price: tick.prevClose, kind: 'Previous close' },
    { price: tick.high, kind: "Day's high" },
    { price: tick.low, kind: "Day's low" },
    { price: tick.open, kind: "Day's open" },
  ];
  if (vwap) raw.push({ price: vwap, kind: 'VWAP' });
  const merged = [];
  for (const l of raw.filter((x) => Number.isFinite(x.price)).sort((a, b) => a.price - b.price)) {
    const prev = merged.at(-1);
    if (prev && Math.abs(l.price - prev.price) / prev.price < 0.0015) {
      if (!prev.kind.includes(l.kind)) prev.kind += ` · ${l.kind}`;
    } else merged.push({ ...l });
  }
  const levels = merged.map((l) => ({ price: roundToTick(l.price), kind: l.kind }));
  return {
    supports: levels.filter((l) => l.price < ltp).reverse(),
    resistances: levels.filter((l) => l.price > ltp),
  };
}

function scoreFactors({ ltp, c5, c15, tick, vwap, mood }) {
  const factors = [];

  if (vwap) {
    const diff = (ltp - vwap) / vwap;
    const vote = Math.abs(diff) < 0.0005 ? 0 : sign(diff);
    factors.push(factor('vwap', 'VWAP', vote, vote === 0 ? `Price is sitting on VWAP (${fmt(vwap)})` : `Price is ${vote > 0 ? 'above' : 'below'} VWAP (${fmt(vwap)})`));
  }

  const e9 = last(ema(c5, 9));
  const e21 = last(ema(c5, 21));
  if (e9 != null && e21 != null) {
    const vote = trendVote(e9, e21);
    factors.push(factor('ema5', 'Trend (5m)', vote, vote === 0 ? 'EMA 9 and EMA 21 are flat on 5-minute bars' : `EMA 9 is ${vote > 0 ? 'above' : 'below'} EMA 21 on 5-minute bars`));
  }

  const h9 = last(ema(c15, 9));
  const h21 = last(ema(c15, 21));
  if (h9 != null && h21 != null) {
    const vote = trendVote(h9, h21);
    factors.push(factor('ema15', 'Trend (15m)', vote, `The 15-minute trend is ${['down', 'flat', 'up'][vote + 1]} (EMA 9 vs 21)`));
  } else {
    factors.push(factor('ema15', 'Trend (15m)', 0, 'Not enough 15-minute bars yet to read the bigger trend'));
  }

  const r = last(rsi(c5, 14));
  if (r != null) {
    let vote = 0;
    let text = `RSI ${r.toFixed(0)} is neutral`;
    if (r > 75) text = `RSI ${r.toFixed(0)} is overbought, so a pullback is likely`;
    else if (r < 25) text = `RSI ${r.toFixed(0)} is oversold, so a bounce is likely`;
    else if (r >= 55) [vote, text] = [1, `RSI ${r.toFixed(0)} shows buyers in control`];
    else if (r <= 45) [vote, text] = [-1, `RSI ${r.toFixed(0)} shows sellers in control`];
    factors.push(factor('rsi', 'Momentum (RSI)', vote, text));
  }

  const hist = macd(c5).histogram;
  if (hist.length >= 2) {
    const [prev, cur] = [hist.at(-2).value, hist.at(-1).value];
    let vote = 0;
    let text = 'MACD momentum is fading';
    if (cur > 0 && cur >= prev) [vote, text] = [1, 'MACD is positive and rising'];
    else if (cur < 0 && cur <= prev) [vote, text] = [-1, 'MACD is negative and falling'];
    factors.push(factor('macd', 'Momentum (MACD)', vote, text));
  }

  // Last completed 5m bar against the 20 before it.
  const done = c5.slice(0, -1);
  if (done.length > 21 && done.at(-1).volume > 0) {
    const bar = done.at(-1);
    const avg = done.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    const ratio = avg ? bar.volume / avg : 0;
    const vote = ratio >= 1.5 ? sign(bar.close - bar.open) : 0;
    factors.push(
      factor('volume', 'Volume', vote, vote === 0 ? `Volume is normal (${ratio.toFixed(1)}x average)` : `Volume spike (${ratio.toFixed(1)}x average) on a ${vote > 0 ? 'green' : 'red'} bar`),
    );
  }

  const buy = tick.totalBuyQty;
  const sell = tick.totalSellQty;
  if (buy && sell) {
    const share = buy / (buy + sell);
    const vote = share > 0.6 ? 1 : share < 0.4 ? -1 : 0;
    factors.push(factor('depth', 'Order book', vote, `${Math.round(share * 100)}% of pending quantity is on the buy side`));
  }

  if (mood != null) {
    const vote = mood > MOOD_PCT ? 1 : mood < -MOOD_PCT ? -1 : 0;
    factors.push(factor('mood', 'Nifty 50', vote, `Nifty 50 is ${mood >= 0 ? 'up' : 'down'} ${Math.abs(mood).toFixed(2)}% today`));
  }

  return { factors, rsi: r, ema9: e9, ema21: e21 };
}

function buildPlan(side, { ltp, levels, atrValue }) {
  const dir = side === 'BUY' ? 1 : -1;
  const stops = side === 'BUY' ? levels.supports : levels.resistances;
  const goals = side === 'BUY' ? levels.resistances : levels.supports;
  const away = (l) => Math.abs(l.price - ltp) >= atrValue * 0.3;

  const stopLevel = stops.find(away);
  let risk = stopLevel ? Math.abs(ltp - stopLevel.price) + atrValue * 0.2 : atrValue * 1.5;
  risk = Math.max(risk, atrValue * 0.75, ltp * MIN_RISK_PCT);
  const stopLoss = roundToTick(ltp - dir * risk);

  const goal = goals.find(away);
  const target = roundToTick(goal ? goal.price - dir * atrValue * 0.1 : ltp + dir * risk * 2);
  const riskReward = round2(Math.abs(target - ltp) / risk);
  const zone = [roundToTick(ltp - dir * atrValue * 0.25), roundToTick(ltp)].sort((a, b) => a - b);

  return {
    entryLow: zone[0],
    entryHigh: zone[1],
    stopLoss,
    stopReason: stopLevel ? `just ${side === 'BUY' ? 'below' : 'above'} ${levelName(stopLevel.kind)} ${fmt(stopLevel.price)}` : '1.5x the average bar range away',
    target,
    targetReason: goal ? `just before ${levelName(goal.kind)} ${fmt(goal.price)}` : `no level in view, so 2x the risk`,
    riskReward,
  };
}

/**
 * @param {object} input
 * @param {object} input.tick latest tick for the stock
 * @param {Array} input.c5 5-minute candles, oldest first
 * @param {Array} input.c15 15-minute candles, oldest first
 * @param {number|null} input.niftyChangePct Nifty 50 change % today
 */
export function analyze({ symbol, tick, c5, c15, niftyChangePct = null }) {
  const base = { symbol, generatedAt: new Date().toISOString() };
  if (!tick || c5.length < 30) {
    return { ...base, action: 'NO_TRADE', score: 0, maxScore: 0, headline: 'Not enough data yet', factors: [], plan: null, invalidation: [], levels: { supports: [], resistances: [] } };
  }

  const ltp = tick.ltp;
  const vwap = sessionVwap(c5);
  const atrValue = atr(c5, 14) || ltp * 0.003;
  const { factors, rsi: r, ema9, ema21 } = scoreFactors({ ltp, c5, c15, tick, vwap, mood: niftyChangePct });
  const levels = buildLevels({ ltp, c5, tick, vwap });
  const score = factors.reduce((s, f) => s + f.vote, 0);
  const maxScore = factors.length;
  const trend = factors.filter((f) => ['vwap', 'ema5', 'ema15'].includes(f.id));

  let action = 'NO_TRADE';
  let headline = 'Signals are mixed, so wait';
  let side = null;
  if (score >= BUY_SCORE && trend.every((f) => f.vote >= 0)) side = 'BUY';
  else if (score <= -BUY_SCORE && trend.every((f) => f.vote <= 0)) side = 'SELL';
  else if (Math.abs(score) >= BUY_SCORE) headline = 'Momentum and trend disagree, so wait';

  let plan = null;
  if (side === 'BUY' && r > 75) headline = 'Uptrend, but stretched. Wait for a pullback';
  else if (side === 'SELL' && r < 25) headline = 'Downtrend, but stretched. Wait for a bounce';
  else if (side) {
    plan = buildPlan(side, { ltp, levels, atrValue });
    if (plan.riskReward < MIN_RISK_REWARD) {
      headline = `${side === 'BUY' ? 'Bullish' : 'Bearish'}, but the next level is too close (${plan.riskReward}:1 reward to risk)`;
      plan = null;
    } else {
      action = side;
      headline = side === 'BUY' ? 'Buyers in control' : 'Sellers in control';
    }
  }

  const invalidation = [];
  if (action === 'BUY') {
    invalidation.push(`A 5-minute close below ${fmt(plan.stopLoss)}`);
    if (vwap) invalidation.push(`Price closes back under VWAP (${fmt(vwap)})`);
    invalidation.push('Nifty 50 turns sharply red');
  } else if (action === 'SELL') {
    invalidation.push(`A 5-minute close above ${fmt(plan.stopLoss)}`);
    if (vwap) invalidation.push(`Price closes back over VWAP (${fmt(vwap)})`);
    invalidation.push('Nifty 50 turns sharply green');
  }

  return {
    ...base,
    action,
    score,
    maxScore,
    strength: Math.abs(score) >= 6 ? 'Strong' : Math.abs(score) >= BUY_SCORE ? 'Moderate' : 'Weak',
    headline,
    ltp,
    factors,
    plan,
    invalidation,
    levels: { supports: levels.supports.slice(0, 3), resistances: levels.resistances.slice(0, 3) },
    indicators: { vwap: vwap && round2(vwap), ema9, ema21, rsi: r, atr: round2(atrValue) },
  };
}

/** Advice for someone already holding the stock. */
export function positionAdvice(signal, netQty) {
  if (!netQty) return null;
  const long = netQty > 0;
  const against = long ? signal.action === 'SELL' || signal.score <= -BUY_SCORE + 1 : signal.action === 'BUY' || signal.score >= BUY_SCORE - 1;
  return against
    ? { advice: 'CONSIDER_EXIT', text: `The chart has turned against your ${long ? 'long' : 'short'} position. Consider exiting or tightening your stop loss.` }
    : { advice: 'HOLD', text: `Nothing on the chart says to exit your ${long ? 'long' : 'short'} yet. Keep your stop loss in place.` };
}
