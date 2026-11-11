import { istParts } from '../market/marketHours.js';
import { aggregateCandles } from '../market/providers/BaseProvider.js';

// "Is it a good time to trade?" in one card: the index's own behaviour today (trending or choppy, quiet or wild) and your own state
// (losses today, losses in a row, trades left, the pause). Professional traders switch a breakout system off in a choppy market and stop
// for the day after a run of losses; this puts both in front of you before the bot or you buy. It never buys or blocks anything itself,
// except the rules you already switched on (daily loss limit, losses in a row, pause).

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * How the index is moving today, from its 1-minute candles of today and its daily candles.
 * - efficiency: how straight the day's path is, |last close - first open| divided by the sum of every 5-minute move (Kaufman's efficiency
 *   ratio). Near 1 is a one-way trend, under 0.25 is back-and-forth chop where breakouts and crosses fail.
 * - rangeVsUsual: today's high-low range against the average range of the last 10 sessions (1 = a normal day so far).
 * - flips: how many times the 5-minute bars changed direction over the last 12 bars (an hour). Many flips = chop.
 */
export function marketMood(c1, daily = []) {
  const bars = aggregateCandles(c1.map((c) => ({ ...c })), '5m');
  if (bars.length < 6) return null;
  let path = 0;
  for (let i = 1; i < bars.length; i++) path += Math.abs(bars[i].close - bars[i - 1].close);
  path += Math.abs(bars[0].close - bars[0].open);
  const net = bars.at(-1).close - bars[0].open;
  const efficiency = path > 0 ? Math.abs(net) / path : 0;
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  const today = bars[0].time;
  const past = daily.filter((d) => d.time < today - 6 * 3600).slice(-10);
  const usual = past.length ? past.reduce((s, d) => s + (d.high - d.low), 0) / past.length : null;
  const last = bars.slice(-13);
  let flips = 0;
  for (let i = 2; i < last.length; i++) {
    const a = Math.sign(last[i - 1].close - last[i - 2].close);
    const b = Math.sign(last[i].close - last[i - 1].close);
    if (a && b && a !== b) flips += 1;
  }
  const kind = efficiency >= 0.4 ? 'trend' : efficiency < 0.25 || flips >= 7 ? 'chop' : 'mixed';
  return {
    kind,
    efficiency: r2(efficiency),
    direction: net > 0 ? 'up' : net < 0 ? 'down' : 'flat',
    move: r2(net),
    range: r2(high - low),
    rangeVsUsual: usual ? r2((high - low) / usual) : null,
    flips,
    bars: bars.length,
  };
}

/**
 * The verdict: 'go' (green), 'care' (amber) or 'stop' (red), with every reason in plain words.
 * @param mood    marketMood(), or null before 09:45
 * @param me      { pnl, trades, maxTrades (0 = no limit), dailyLoss (rupees), lossesInARow, lossStreak (0 = off), paused, open, capLoss, benched: [names] }
 */
export function todayVerdict(mood, me, { minutes = null } = {}) {
  const reasons = [];
  let level = 0; // 0 go, 1 care, 2 stop
  const say = (lvl, text) => {
    reasons.push({ level: ['go', 'care', 'stop'][lvl], text });
    level = Math.max(level, lvl);
  };
  if (me.paused) say(2, 'You paused new automatic buys for today.');
  if (me.dailyLoss > 0 && me.pnl <= -me.dailyLoss) say(2, `Today is ₹${Math.round(-me.pnl).toLocaleString('en-IN')} down, past your daily limit of ₹${Math.round(me.dailyLoss).toLocaleString('en-IN')}. Stop for the day.`);
  if (me.lossStreak > 0 && me.lossesInARow >= me.lossStreak) say(2, `${me.lossesInARow} losing trades in a row today. The bot takes no new buy until tomorrow; a hand-made trade now is usually revenge.`);
  else if (me.lossesInARow >= 1) say(1, `The last trade lost. ${me.lossStreak > 0 ? `${me.lossStreak - me.lossesInARow} more loss in a row stops the bot for today.` : 'Consider a pause before the next one.'}`);
  if (!(me.maxTrades > 0)) say(0, `${me.trades} trade${me.trades === 1 ? '' : 's'} today; no daily trade limit set.`);
  else if (me.trades >= me.maxTrades) say(2, `All ${me.maxTrades} trades for today are used.`);
  else say(0, `${me.maxTrades - me.trades} of ${me.maxTrades} trades left today.`);
  if (me.benched?.length) say(1, `Switched off by themselves after losses in a row: ${me.benched.join(', ')}. Look at their trades before turning them on.`);
  if (minutes != null && minutes < 9 * 60 + 45) say(1, 'Before 09:45 the first moves often reverse.');
  if (!mood) say(1, 'Not enough of today to judge the market yet (it needs half an hour of candles).');
  else if (mood.kind === 'chop') say(1, `The index is choppy: only ${Math.round(mood.efficiency * 100)}% of its movement went anywhere${mood.flips >= 7 ? `, and it changed direction ${mood.flips} times in the last hour` : ''}. Breakouts and crosses fail most in this. Fewer trades, or none.`);
  else if (mood.kind === 'trend') say(0, `The index is trending ${mood.direction} (${Math.round(mood.efficiency * 100)}% of its movement went one way). Entries with the trend have the best odds; entries against it the worst.`);
  else say(0, `The index is mixed: some trend, some chop (${Math.round(mood.efficiency * 100)}% efficient).`);
  if (mood?.rangeVsUsual != null && mood.rangeVsUsual >= 1.3) say(1, `Today's range is already ${mood.rangeVsUsual} times a normal day: big moves are often spent, and premiums swing hard.`);
  if (mood?.rangeVsUsual != null && mood.rangeVsUsual < 0.5 && minutes != null && minutes > 11 * 60) say(1, `A very quiet day (range ${mood.rangeVsUsual} of normal): option premiums lose value while nothing moves.`);
  const verdict = ['go', 'care', 'stop'][level];
  const headline = { go: 'OK to trade, with your normal rules', care: 'Trade with care: fewer and smaller', stop: 'Stop for today' }[verdict];
  return { verdict, headline, reasons };
}

/** Today's IST minutes, for the early-session warning. */
export const istMinutesNow = (now = new Date()) => istParts(now).minutes;
