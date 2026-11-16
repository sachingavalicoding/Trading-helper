import { prepare, findSignals, TECHNIQUES, BUFFER_ATR } from '../study/patterns.js';
import { istParts } from '../market/marketHours.js';
import * as S from './series.js';
import { explainCondition } from './explain.js';
import { optionView } from './optionData.js';

// The checks a combination is built from. Each is written once, for a call (a rise); a put is the same check on the mirrored
// chart (prices negated, breadth turned round), so every condition has a put twin that cannot drift out of step with it.
// A check is a "state" (it is true now: RSI above 50) or an "event" (something just happened: MACD crossed up). A combination
// needs its states true on the bar and its events seen within the last few bars. Nothing here looks at a bar after the one asked about.

const num = (x) => x != null && Number.isFinite(x);
const gt = (a, b) => num(a) && num(b) && a > b;
const ge = (a, b) => num(a) && num(b) && a >= b;
const lt = (a, b) => num(a) && num(b) && a < b;
const crossUp = (a, b, i) => {
  const at = (x, k) => (Array.isArray(x) ? x[k] : x);
  return i > 0 && gt(at(a, i), at(b, i)) && num(at(a, i - 1)) && num(at(b, i - 1)) && at(a, i - 1) <= at(b, i - 1);
};

export const GROUPS = ['Trend', 'Momentum', 'Volatility', 'Volume and VWAP', 'Pivots and levels', 'Candles', 'Market', 'Time of day', 'Options', 'Chart patterns', 'News'];

export const CONDITIONS = [];
const add = (group, key, label, text, test, o = {}) => CONDITIONS.push({ key, label, group, text, kind: o.event ? 'event' : 'state', needs: o.needs || null, test });

// ---------- Trend ----------
add('Trend', 'emaFastOverSlow', 'EMA 9 above EMA 21', 'The 9-bar average is above the 21-bar average: the short trend is up.', (c, i) => gt(c.ema(9)[i], c.ema(21)[i]));
add('Trend', 'ema21Over50', 'EMA 21 above EMA 50', 'The medium trend is up.', (c, i) => gt(c.ema(21)[i], c.ema(50)[i]));
add('Trend', 'emaStack', 'EMA 9 > 21 > 50 lined up', 'All three averages are lined up upward: a clean trend.', (c, i) => gt(c.ema(9)[i], c.ema(21)[i]) && gt(c.ema(21)[i], c.ema(50)[i]));
add('Trend', 'aboveEma20', 'Price above EMA 20', 'The last close is above its 20-bar average.', (c, i) => gt(c.C[i], c.ema(20)[i]));
add('Trend', 'aboveEma50', 'Price above EMA 50', 'The last close is above its 50-bar average.', (c, i) => gt(c.C[i], c.ema(50)[i]));
add('Trend', 'aboveEma200', 'Price above EMA 200', 'Above the long-run average (about 2.5 sessions of 5-minute bars).', (c, i) => gt(c.C[i], c.ema(200)[i]));
add('Trend', 'aboveSma20', 'Price above SMA 20', 'The last close is above the simple 20-bar average.', (c, i) => gt(c.C[i], c.sma(20)[i]));
add('Trend', 'aboveSma50', 'Price above SMA 50', 'The last close is above the simple 50-bar average.', (c, i) => gt(c.C[i], c.sma(50)[i]));
add('Trend', 'aboveHma21', 'Price above Hull average 21', 'The Hull average reacts faster than the others; price is above it.', (c, i) => gt(c.C[i], c.hma(21)[i]));
add('Trend', 'ema21Rising', 'EMA 21 rising', 'The 21-bar average is higher than 3 bars ago.', (c, i) => i >= 3 && gt(c.ema(21)[i], c.ema(21)[i - 3]));
add('Trend', 'ema50Rising', 'EMA 50 rising', 'The 50-bar average is higher than 5 bars ago.', (c, i) => i >= 5 && gt(c.ema(50)[i], c.ema(50)[i - 5]));
add('Trend', 'supertrendUp', 'Supertrend (10, 3) up', 'The supertrend line is below price.', (c, i) => c.st(10, 3).dir[i] === 1);
add('Trend', 'supertrendFastUp', 'Supertrend (7, 2) up', 'A quicker supertrend is below price.', (c, i) => c.st(7, 2).dir[i] === 1);
add('Trend', 'psarBelow', 'Parabolic SAR below price', 'The trailing dot sits under the price.', (c, i) => c.psar()?.dir[i] === 1);
add('Trend', 'adxUp', 'ADX over 20 and +DI over -DI', 'A trend exists (ADX over 20) and buyers lead it.', (c, i) => gt(c.dmi().adx[i], 20) && gt(c.dmi().pdi[i], c.dmi().ndi[i]));
add('Trend', 'adxStrong', 'ADX over 25 (strong trend)', 'A strong trend is under way, either way. It does not pick a direction, so pair it with another check.', (c, i) => gt(c.dmi().adx[i], 25));
add('Trend', 'diPositive', '+DI above -DI', 'Upward movement is stronger than downward movement.', (c, i) => gt(c.dmi().pdi[i], c.dmi().ndi[i]));
add('Trend', 'aroonUp', 'Aroon up over 70', 'The high of the last 25 bars is recent and the low is old.', (c, i) => gt(c.aroon().up[i], 70) && gt(c.aroon().up[i], c.aroon().down[i]));
add('Trend', 'aroonLead', 'Aroon up above Aroon down', 'The latest high is newer than the latest low.', (c, i) => gt(c.aroon().up[i], c.aroon().down[i]));
add('Trend', 'cloudAbove', 'Price above the Ichimoku cloud', 'Price is above both cloud edges.', (c, i) => gt(c.C[i], Math.max(c.ichi().spanA[i] ?? -Infinity, c.ichi().spanB[i] ?? -Infinity)) && num(c.ichi().spanA[i]) && num(c.ichi().spanB[i]));
add('Trend', 'tenkanOverKijun', 'Ichimoku fast line above slow line', 'The 9-bar midpoint is above the 26-bar midpoint.', (c, i) => gt(c.ichi().tenkan[i], c.ichi().kijun[i]));
add('Trend', 'vortexUp', 'Vortex +VI above -VI', 'Upward vortex movement dominates.', (c, i) => gt(c.vortex().pos[i], c.vortex().neg[i]));
add('Trend', 'linregUp', 'Rising straight-line trend (20 bars)', 'The best-fit line through 20 bars slopes up and fits well (R squared over 0.6).', (c, i) => gt(c.linreg().slope[i], 0) && gt(c.linreg().r2[i], 0.6));
add('Trend', 'higherHL', 'Higher highs and higher lows', 'The last 3 bars have a higher high and a higher low than the 3 before.', (c, i) => i >= 6 && Math.min(c.L[i], c.L[i - 1], c.L[i - 2]) > Math.min(c.L[i - 3], c.L[i - 4], c.L[i - 5]) && Math.max(c.H[i], c.H[i - 1], c.H[i - 2]) > Math.max(c.H[i - 3], c.H[i - 4], c.H[i - 5]));
add('Trend', 'aboveDayOpen', "Above the day's open", 'Price is above where the day opened.', (c, i) => gt(c.C[i], c.dayOpen(i)));
add('Trend', 'aboveYClose', "Above yesterday's close", 'The day is up.', (c, i) => gt(c.C[i], c.prevClose(i)));
add('Trend', 'aboveYHigh', "Above yesterday's high", 'Price is trading over the whole of yesterday.', (c, i) => gt(c.C[i], c.prevHigh(i)));
add('Trend', 'aboveDayMean', "Above the day's average price", 'Price is above the average close of today so far.', (c, i) => gt(c.C[i], c.dayMean()[i]));
add('Trend', 'aboveOR', 'Above the opening range', 'Price is above the high of the first 15 minutes (after 09:30).', (c, i) => gt(c.C[i], c.orHigh(i)));
add('Trend', 'nearDayHigh', "Near the day's high", "Within 0.3 ATR of the day's high.", (c, i) => num(c.dayHigh()[i]) && num(c.atr[i]) && c.dayHigh()[i] - c.C[i] <= 0.3 * c.atr[i]);
add('Trend', 'trixUp', 'TRIX above zero', 'The triple-smoothed rate of change is positive.', (c, i) => gt(c.trix()[i], 0));
add('Trend', 'gapUp', 'Gapped up at the open (0.3%+)', 'The day opened at least 0.3% over yesterday close.', (c, i) => {
  const pc = c.prevClose(i);
  const o = c.dayOpen(i);
  return num(pc) && num(o) && o - pc >= 0.003 * Math.abs(pc);
});

// ---------- Momentum ----------
add('Momentum', 'rsiAbove50', 'RSI (14) above 50', 'Buying pressure leads.', (c, i) => gt(c.rsi(14)[i], 50));
add('Momentum', 'rsiHealthy', 'RSI (14) between 50 and 70', 'Strong but not stretched.', (c, i) => gt(c.rsi(14)[i], 50) && lt(c.rsi(14)[i], 70));
add('Momentum', 'rsiFast', 'RSI (7) above 55', 'A quicker RSI shows buying pressure.', (c, i) => gt(c.rsi(7)[i], 55));
add('Momentum', 'rsiRising', 'RSI (14) rising', 'RSI is higher than 3 bars ago.', (c, i) => i >= 3 && gt(c.rsi(14)[i], c.rsi(14)[i - 3]));
add('Momentum', 'rsiCross30', 'RSI crosses up through 30', 'The oversold bounce.', (c, i) => crossUp(c.rsi(14), 30, i), { event: true });
add('Momentum', 'rsiCross50', 'RSI crosses up through 50', 'Momentum turns up.', (c, i) => crossUp(c.rsi(14), 50, i), { event: true });
add('Momentum', 'macdAbove', 'MACD above its signal line', 'MACD line over its 9-bar average.', (c, i) => gt(c.macd().line[i], c.macd().signal[i]));
add('Momentum', 'macdHistUp', 'MACD histogram positive and rising', 'Momentum is up and growing.', (c, i) => i > 0 && gt(c.macd().hist[i], 0) && gt(c.macd().hist[i], c.macd().hist[i - 1]));
add('Momentum', 'macdZero', 'MACD above zero', 'The 12 EMA is over the 26 EMA.', (c, i) => gt(c.macd().line[i], 0));
add('Momentum', 'macdCross', 'MACD crosses above its signal', 'A fresh upward cross.', (c, i) => crossUp(c.macd().line, c.macd().signal, i), { event: true });
add('Momentum', 'macdHistTurn', 'MACD histogram turns up', 'The histogram stops falling and rises while it is still below zero.', (c, i) => i > 1 && lt(c.macd().hist[i - 1], 0) && gt(c.macd().hist[i], c.macd().hist[i - 1]) && ge(c.macd().hist[i - 2], c.macd().hist[i - 1]), { event: true });
add('Momentum', 'stochAbove', 'Stochastic %K above %D', 'The fast line is over the slow line.', (c, i) => gt(c.stoch().k[i], c.stoch().d[i]));
add('Momentum', 'stochAbove50', 'Stochastic %K above 50', 'Price is in the upper half of its 14-bar range.', (c, i) => gt(c.stoch().k[i], 50));
add('Momentum', 'stochCross', 'Stochastic turns up from below 20', '%K crosses over %D while still under 20.', (c, i) => crossUp(c.stoch().k, c.stoch().d, i) && lt(c.stoch().k[i - 1], 20), { event: true });
add('Momentum', 'cciAbove0', 'CCI (20) above 0', 'Price is over its typical level.', (c, i) => gt(c.cci()[i], 0));
add('Momentum', 'cciStrong', 'CCI (20) above 100', 'Unusually strong.', (c, i) => gt(c.cci()[i], 100));
add('Momentum', 'cciCross', 'CCI crosses up through -100', 'Bounce from an oversold reading.', (c, i) => crossUp(c.cci(), -100, i), { event: true });
add('Momentum', 'willrAbove50', 'Williams %R above -50', 'Price is in the upper half of its 14-bar range.', (c, i) => gt(c.willr()[i], -50));
add('Momentum', 'willrCross', 'Williams %R crosses up through -80', 'Leaves the oversold zone.', (c, i) => crossUp(c.willr(), -80, i), { event: true });
add('Momentum', 'aoAbove0', 'Awesome oscillator above 0', '5-bar midpoint average over the 34-bar one.', (c, i) => gt(c.ao()[i], 0));
add('Momentum', 'aoTurn', 'Awesome oscillator turns up', 'It rises after two falling bars.', (c, i) => i > 1 && gt(c.ao()[i], c.ao()[i - 1]) && lt(c.ao()[i - 1], c.ao()[i - 2]), { event: true });
add('Momentum', 'ultAbove50', 'Ultimate oscillator above 50', 'Momentum over three time frames is positive.', (c, i) => gt(c.ult()[i], 50));
add('Momentum', 'up10', 'Price up over 10 bars', 'The close is above the close 10 bars ago.', (c, i) => i >= 10 && gt(c.C[i], c.C[i - 10]));
add('Momentum', 'push6', 'Pushed 1.5 ATR in 6 bars', 'A fast move up.', (c, i) => i >= 6 && num(c.atr[i]) && c.C[i] - c.C[i - 6] >= 1.5 * c.atr[i]);
add('Momentum', 'threeUp', 'Three higher closes in a row', 'Steady buying.', (c, i) => i >= 3 && c.C[i] > c.C[i - 1] && c.C[i - 1] > c.C[i - 2] && c.C[i - 2] > c.C[i - 3]);

// ---------- Volatility ----------
add('Volatility', 'bbAboveMid', 'Price above the Bollinger middle', 'Over the 20-bar average, inside the bands.', (c, i) => gt(c.C[i], c.bb().mid[i]));
add('Volatility', 'bbUpper', 'Close above the upper Bollinger band', 'A push beyond two standard deviations.', (c, i) => gt(c.C[i], c.bb().upper[i]));
add('Volatility', 'bbMidCross', 'Price crosses up through the Bollinger middle', 'A fresh move over the average.', (c, i) => crossUp(c.C, c.bb().mid, i), { event: true });
add('Volatility', 'bbLowerBounce', 'Bounce off the lower Bollinger band', 'Price dipped under the lower band and closed back over it.', (c, i) => i > 0 && lt(c.C[i - 1], c.bb().lower[i - 1]) && gt(c.C[i], c.bb().lower[i]), { event: true });
add('Volatility', 'bbSqueeze', 'Bollinger squeeze (tight bands)', 'The bands are as narrow as at any time in the last 50 bars: a big move is brewing, either way.', (c, i) => {
  const w = c.bbWidth();
  if (i < 50 || !num(w[i])) return false;
  for (let k = i - 49; k < i; k++) if (!num(w[k]) || w[k] < w[i]) return false;
  return true;
});
add('Volatility', 'keltnerUpper', 'Close above the upper Keltner channel', 'A push beyond 1.5 ATR over the 20 EMA.', (c, i) => gt(c.C[i], c.kc().upper[i]));
add('Volatility', 'atrExpand', 'ATR expanding', 'Ranges are 10% wider than 10 bars ago: the market is waking up. No direction by itself.', (c, i) => i >= 10 && num(c.atrFull()[i]) && num(c.atrFull()[i - 10]) && c.atrFull()[i] > 1.1 * c.atrFull()[i - 10]);
add('Volatility', 'high20', '20-bar high broken', 'The close is above the highest high of the 20 bars before.', (c, i) => i >= 20 && c.C[i] > Math.max(...c.H.slice(i - 20, i)), { event: true });
add('Volatility', 'bigBullBar', 'Big bullish bar', 'A bar of 1.2 ATR or more that closes in its top third.', (c, i) => {
  const r = c.H[i] - c.L[i];
  return num(c.atr[i]) && r >= 1.2 * c.atr[i] && c.C[i] >= c.L[i] + (2 / 3) * r;
});

// ---------- Volume and VWAP (needs the 50 stocks' traded value for the index, the share's own volume for a share) ----------
const V = { needs: 'flow' };
add('Volume and VWAP', 'aboveVwap', 'Price above VWAP', 'Over the volume-weighted average of the day: buyers hold the day.', (c, i) => gt(c.C[i], c.vwap()?.[i]), V);
add('Volume and VWAP', 'vwapCross', 'Price crosses up through VWAP', 'A fresh move over the day average price.', (c, i) => crossUp(c.C, c.vwap() || [], i), { ...V, event: true });
add('Volume and VWAP', 'vwapRising', 'VWAP rising', 'The day average is higher than 3 bars ago.', (c, i) => i >= 3 && gt(c.vwap()?.[i], c.vwap()?.[i - 3]), V);
add('Volume and VWAP', 'vwapStretched', 'Price 0.5 ATR or more above VWAP', 'Clear of the day average: the move has room, though it may be stretched.', (c, i) => num(c.vwap()?.[i]) && num(c.atr[i]) && c.C[i] - c.vwap()[i] >= 0.5 * c.atr[i], V);
add('Volume and VWAP', 'volHigh', 'Volume 1.5 times the usual', 'Traded value is 1.5 times the average of the last 20 bars. No direction by itself.', (c, i) => c.heavy(i, 1.5), V);
add('Volume and VWAP', 'volSurge', 'Volume 2.5 times the usual', 'A surge in traded value. No direction by itself.', (c, i) => c.heavy(i, 2.5), V);
add('Volume and VWAP', 'heavyBuy', 'Heavy buying bar', 'A bullish bar on 1.5 times the usual volume.', (c, i) => c.C[i] > c.O[i] && c.heavy(i, 1.5), V);
add('Volume and VWAP', 'obvUp', 'OBV above its 20-bar average', 'On-balance volume trends up.', (c, i) => gt(c.obv()?.[i], c.obvAvg()?.[i]), V);
add('Volume and VWAP', 'cmfPositive', 'Chaikin money flow above 0', 'Bars close nearer their highs on volume.', (c, i) => gt(c.cmf()?.[i], 0), V);
add('Volume and VWAP', 'cmfStrong', 'Chaikin money flow above 0.1', 'Clear accumulation.', (c, i) => gt(c.cmf()?.[i], 0.1), V);
add('Volume and VWAP', 'mfiAbove50', 'Money flow index above 50', 'Volume-weighted RSI shows more buying than selling.', (c, i) => gt(c.mfi()?.[i], 50), V);
add('Volume and VWAP', 'forceUp', 'Force index above 0', 'Price change times volume is positive.', (c, i) => gt(c.force()?.[i], 0), V);
add('Volume and VWAP', 'quietPullback', 'Pullback on fading volume', 'Price is lower than 3 bars ago but volume is under average: sellers are not pushing.', (c, i) => i >= 3 && c.C[i] < c.C[i - 3] && c.turnAvg(i) != null && c.flow[i] < c.turnAvg(i), V);

// ---------- Candles ----------
add('Candles', 'bullBar', 'Bar closes up', 'The close is above the open.', (c, i) => c.C[i] > c.O[i]);
add('Candles', 'closeAbovePrevHigh', 'Close above the previous high', 'The bar closes over the previous bar high.', (c, i) => i > 0 && c.C[i] > c.H[i - 1], { event: true });
add('Candles', 'strongClose', 'Closes in the top third', 'Buyers won the bar.', (c, i) => c.H[i] > c.L[i] && c.C[i] >= c.L[i] + (2 / 3) * (c.H[i] - c.L[i]));
add('Candles', 'engulfBull', 'Bullish engulfing', 'A bullish body that covers the previous bearish one.', (c, i) => i > 0 && c.C[i - 1] < c.O[i - 1] && c.C[i] > c.O[i] && c.C[i] >= c.O[i - 1] && c.O[i] <= c.C[i - 1], { event: true });
add('Candles', 'hammer', 'Hammer', 'A long lower wick (twice the body, over half the range) and a close in the top third.', (c, i) => {
  const r = c.H[i] - c.L[i];
  const body = Math.abs(c.C[i] - c.O[i]);
  const lower = Math.min(c.C[i], c.O[i]) - c.L[i];
  return r > 0 && lower >= 2 * body && lower >= 0.5 * r && c.C[i] >= c.L[i] + (2 / 3) * r;
}, { event: true });
add('Candles', 'soldiers', 'Three advancing bars', 'Three bullish bars, each closing higher with a real body.', (c, i) => i >= 2 && [0, 1, 2].every((k) => {
  const j = i - k;
  return c.C[j] > c.O[j] && c.C[j] - c.O[j] >= 0.5 * (c.H[j] - c.L[j]) && (k === 2 || c.C[j] > c.C[j - 1]);
}), { event: true });
add('Candles', 'higherLow', 'Higher low formed', 'The last bar low is above the low of the 5 bars before.', (c, i) => i >= 5 && c.L[i] > Math.min(...c.L.slice(i - 5, i)) && c.L[i - 1] <= c.L[i]);
add('Candles', 'marubozu', 'Full-bodied bullish bar', 'A bullish bar with almost no wicks (body over 80% of the range).', (c, i) => {
  const r = c.H[i] - c.L[i];
  return r > 0 && c.C[i] > c.O[i] && c.C[i] - c.O[i] >= 0.8 * r;
});
add('Candles', 'gapAndHold', 'Gap-and-go bar', 'A bar opening over the previous high and closing higher.', (c, i) => i > 0 && c.O[i] > c.H[i - 1] && c.C[i] > c.O[i], { event: true });

// ---------- Market ----------
const B = { needs: 'breadth' };
add('Market', 'breadth60', 'Nifty 50 breadth 60%+', 'At least 60% of the 50 stocks are above yesterday close (for a put: below).', (c, i) => ge(c.breadth?.[i], 0.6), B);
add('Market', 'breadth70', 'Nifty 50 breadth 70%+', 'At least 70% of the 50 stocks agree.', (c, i) => ge(c.breadth?.[i], 0.7), B);
add('Market', 'breadth80', 'Nifty 50 breadth 80%+', 'At least 80% of the 50 stocks agree: a one-way day.', (c, i) => ge(c.breadth?.[i], 0.8), B);
add('Market', 'breadthRising', 'Breadth improving', 'The share of stocks on this side is 5 points higher than 3 bars ago.', (c, i) => i >= 3 && num(c.breadth?.[i]) && num(c.breadth?.[i - 3]) && c.breadth[i] - c.breadth[i - 3] >= 0.05, B);
add('Market', 'breadthCross', 'Breadth crosses to the majority', 'More than half of the 50 stocks switch to this side.', (c, i) => crossUp(c.breadth || [], 0.5, i), { ...B, event: true });

// ---------- Time of day (no direction) ----------
add('Time of day', 'morning', 'Morning (09:30 to 11:30)', 'The most active hours.', (c, i) => c.minutes(i) >= 570 && c.minutes(i) < 690);
add('Time of day', 'midday', 'Midday (11:30 to 13:30)', 'The usual lull: moves are smaller and break less often.', (c, i) => c.minutes(i) >= 690 && c.minutes(i) < 810);
add('Time of day', 'afternoon', 'Afternoon (13:30 to 15:00)', 'Positions are built for the close.', (c, i) => c.minutes(i) >= 810 && c.minutes(i) < 900);
add('Time of day', 'afterTen', 'After 10:00', 'Skips the opening noise.', (c, i) => c.minutes(i) >= 600);

// ---------- Trend-day checks: what a big one-way morning (like 2 Nov, 145 points) tends to show early. None of them predicts it alone; use several together. ----------
add('Trend', 'openDrive', 'Open drive (strong first half hour)', 'After 09:30 price is at least 2 ATR over the open and never fell more than half an ATR under it: buyers took the day from the first bar.', (c, i) => {
  const ds = c.dayStartOf(i);
  if (i < ds + 3 || i > ds + 12 || !num(c.atr[i])) return false; // judged between 09:30 and 10:15, while it is still an opening move
  const open = c.O[ds];
  const lowest = Math.min(...c.L.slice(ds, i + 1));
  return c.C[i] - open >= 2 * c.atr[i] && open - lowest <= 0.5 * c.atr[i];
});
add('Trend', 'orBreakEvent', 'Breaks the opening range (first 15 minutes)', 'The close crosses over the high of the first three bars for the first time.', (c, i) => {
  const hi = c.orHigh(i);
  const before = c.orHigh(i - 1);
  return num(hi) && c.C[i] > hi && (!num(before) || c.C[i - 1] <= before);
}, { event: true });
add('Trend', 'yHighBreak', "Breaks yesterday's high", 'The close crosses over the whole of yesterday for the first time today.', (c, i) => {
  const ph = c.prevHigh(i);
  return num(ph) && i > 0 && c.C[i] > ph && c.C[i - 1] <= ph;
}, { event: true });
add('Trend', 'tf15Trend', '15-minute trend up', 'The 15-minute averages (EMA 27 over EMA 63 on 5-minute bars) agree: the bigger picture is up, so a pullback is a gift and not a warning.', (c, i) => gt(c.ema(27)[i], c.ema(63)[i]) && gt(c.C[i], c.ema(63)[i]));
add('Trend', 'adxRising', 'ADX rising (trend getting stronger)', 'ADX is over 18 and higher than 3 bars ago, with buyers leading: a trend is building, not fading.', (c, i) => i >= 3 && gt(c.dmi().adx[i], 18) && gt(c.dmi().adx[i], c.dmi().adx[i - 3]) && gt(c.dmi().pdi[i], c.dmi().ndi[i]));
add('Trend', 'trendingNotChoppy', 'Market is trending (choppiness under 50)', 'The choppiness index over 14 bars is under 50: price is travelling, not wandering. No direction by itself.', (c, i) => lt(c.chop()[i], 50));
add('Volatility', 'squeezeFire', 'Squeeze fires up (Bollinger leaves Keltner)', 'The Bollinger bands were inside the Keltner channel (a coiled market) and have just opened with price above the middle.', (c, i) => {
  if (i < 2) return false;
  const b = c.bb();
  const k = c.kc();
  const inside = (j) => num(b.upper[j]) && num(k.upper[j]) && b.upper[j] < k.upper[j] && b.lower[j] > k.lower[j];
  return inside(i - 1) && !inside(i) && gt(c.C[i], b.mid[i]);
}, { event: true });
add('Volatility', 'nr7Break', 'Narrow bar, then a wide bullish bar', 'The previous bar was the narrowest of the last 7, and this bar is wider and closes up over its high: quiet turns to movement.', (c, i) => {
  if (i < 7) return false;
  const r = (j) => c.H[j] - c.L[j];
  let narrow = true;
  for (let j = i - 7; j < i - 1; j++) if (r(j) <= r(i - 1)) narrow = false;
  return narrow && r(i) > r(i - 1) && c.C[i] > c.H[i - 1];
}, { event: true });
add('Volatility', 'roomLeft', 'Room left in the day (range under 80% of usual)', "Today's range so far is under 80% of the average of the last 5 days: the move is not used up yet. No direction by itself.", (c, i) => {
  const room = c.roomRatio()[i];
  return num(room) && room < 0.8;
});
add('Volume and VWAP', 'vwapHold', 'Pullback to VWAP that holds', 'Price dipped to within 0.3 ATR of VWAP in the last 3 bars, closed back above it, and VWAP is rising: buyers defend the day average.', (c, i) => {
  const vw = c.vwap();
  if (!vw || i < 3 || !num(c.atr[i]) || !num(vw[i]) || !num(vw[i - 3])) return false;
  const touched = [0, 1, 2].some((k) => num(vw[i - k]) && c.L[i - k] - vw[i - k] <= 0.3 * c.atr[i]);
  return touched && c.C[i] > vw[i] && c.C[i] > c.O[i] && vw[i] > vw[i - 3];
}, { ...V, event: true });
add('Volume and VWAP', 'volDryBreak', 'Quiet bars, then a break on volume', 'Three bars on below-average volume, then a close over the 6-bar high on 1.5 times the usual volume: a coil that opens with money behind it.', (c, i) => {
  if (!c.flow || i < 6) return false;
  const quiet = [1, 2, 3].every((k) => num(c.turnAvg(i - k)) && c.flow[i - k] < c.turnAvg(i - k));
  return quiet && c.heavy(i, 1.5) && c.C[i] > Math.max(...c.H.slice(i - 6, i));
}, { ...V, event: true });
add('Time of day', 'notMidday', 'Not midday (skips 11:30 to 13:30)', 'Real-price tests found the midday lull wins least often. Use it as a filter beside an entry check.', (c, i) => c.minutes(i) < 690 || c.minutes(i) >= 810);
add('Time of day', 'firstHour', 'First hour after the open (09:30 to 10:30)', 'The hour most big one-way days are decided.', (c, i) => c.minutes(i) >= 570 && c.minutes(i) < 630);

// ---------- Pivots and levels (added 4 Nov 2026): yesterday's high, low and close turned into today's lines. No volume needed. ----------
// Floor pivot P = (H + L + C) / 3; the CPR runs from (H + L) / 2 to 2P minus that; R1 = 2P - L; Camarilla H3/H4 = C + 1.1 x range / 4 and / 2.
const LV = (c, i) => c.lv(i);
const firstAbove = (c, i, level) => {
  if (!num(level) || !(c.C[i] > level)) return false;
  const ds = c.dayStartOf(i);
  for (let k = ds; k < i; k++) if (c.C[k] > level) return false;
  return c.O[ds] <= level;
};
add('Pivots and levels', 'abovePivot', "Price above today's pivot", "The close is over the floor pivot, (yesterday's high + low + close) / 3: the day leans to buyers.", (c, i) => gt(c.C[i], LV(c, i)?.pp));
add('Pivots and levels', 'aboveCpr', 'Price above the CPR', "The close is over the whole central pivot range (the pivot and the middle of yesterday's high and low).", (c, i) => gt(c.C[i], LV(c, i)?.cprTop));
add('Pivots and levels', 'cprBreakUp', 'First close above the CPR today', 'Price opened at or under the CPR and has just closed over it for the first time today.', (c, i) => firstAbove(c, i, LV(c, i)?.cprTop), { event: true });
add('Pivots and levels', 'cprNarrow', 'Narrow CPR day', "Today's CPR is under 60% of its average width over the last 5 days. Indian traders read a narrow CPR as a likely trending day. No direction by itself.", (c, i) => {
  const lv = LV(c, i);
  return Boolean(lv) && num(lv.widthAvg) && lv.widthAvg > 0 && lv.cprWidth < 0.6 * lv.widthAvg;
});
add('Pivots and levels', 'cprWide', 'Wide CPR day', "Today's CPR is over 1.5 times its 5-day average width: usually a sideways day, better for fades than breakouts. No direction by itself.", (c, i) => {
  const lv = LV(c, i);
  return Boolean(lv) && num(lv.widthAvg) && lv.widthAvg > 0 && lv.cprWidth > 1.5 * lv.widthAvg;
});
add('Pivots and levels', 'cprHigher', "Today's CPR above yesterday's", "The whole of today's CPR sits over yesterday's: value is moving up (an ascending CPR).", (c, i) => {
  const lv = LV(c, i);
  return Boolean(lv?.prev) && gt(lv.cprBottom, lv.prev.cprTop);
});
add('Pivots and levels', 'pivotHold', 'Pullback to the pivot that holds', 'Price dipped to within 0.3 ATR of the pivot (or the CPR top) in the last 3 bars and a bullish bar closes back over it.', (c, i) => {
  const lv = LV(c, i);
  if (!lv || i < 3 || !num(c.atr[i]) || c.dayStartOf(i) > i - 3) return false;
  const level = Math.max(lv.pp, lv.cprTop);
  const touched = [0, 1, 2].some((k) => c.L[i - k] - level <= 0.3 * c.atr[i]);
  return touched && c.C[i] > level && c.C[i] > c.O[i] && c.C[i - 3] > level - 0.3 * c.atr[i];
}, { event: true });
add('Pivots and levels', 'r1Break', 'First close above R1 today', "Price breaks the first resistance, 2 x pivot - yesterday's low: a strong day.", (c, i) => firstAbove(c, i, LV(c, i)?.r1), { event: true });
add('Pivots and levels', 'aboveR1', 'Price above R1', 'Trading over the first floor resistance.', (c, i) => gt(c.C[i], LV(c, i)?.r1));
add('Pivots and levels', 'camH4Up', 'Breaks the Camarilla H4', "First close of the day over H4 (yesterday's close + 1.1 x range / 2): Camarilla traders treat it as a breakout and a possible trend day.", (c, i) => firstAbove(c, i, LV(c, i)?.h4), { event: true });
add('Pivots and levels', 'camL3Up', 'Reclaims the Camarilla L3', 'On a day that opened inside H3 and L3, price closes back over L3 after being under it: the range-day fade.', (c, i) => {
  const lv = LV(c, i);
  const ds = c.dayStartOf(i);
  return Boolean(lv) && i > ds && c.O[ds] > lv.l3 && c.O[ds] < lv.h3 && c.C[i - 1] <= lv.l3 && c.C[i] > lv.l3;
}, { event: true });
add('Pivots and levels', 'camInside', 'Inside the Camarilla H3 to L3', 'Price is between H3 and L3: a balanced, range-bound reading. No direction by itself.', (c, i) => {
  const lv = LV(c, i);
  return Boolean(lv) && c.C[i] > Math.min(lv.l3, lv.h3) && c.C[i] < Math.max(lv.l3, lv.h3);
});
add('Pivots and levels', 'aboveYValue', "Above yesterday's value area", 'Price is over the top of where yesterday spent 70% of its time (market profile, by time at price): buyers accept higher prices.', (c, i) => gt(c.C[i], LV(c, i)?.vah));
add('Pivots and levels', 'abovePoc', "Above yesterday's busiest price", "Price is over yesterday's point of control, the price it spent most time at.", (c, i) => gt(c.C[i], LV(c, i)?.poc));
add('Pivots and levels', 'vaBack', 'Back into value from below (80% rule)', "The day opened under yesterday's value area and has now closed inside it twice in a row: price often crosses the whole area.", (c, i) => {
  const lv = LV(c, i);
  const ds = c.dayStartOf(i);
  return Boolean(lv) && num(lv.val) && i >= ds + 2 && c.O[ds] < lv.val && c.C[i] > lv.val && c.C[i - 1] > lv.val && c.C[i - 2] <= lv.val;
}, { event: true });
add('Pivots and levels', 'insideYRange', "Opened inside yesterday's range", "Today opened between yesterday's high and low: no gap, so levels matter more. No direction by itself.", (c, i) => {
  const lv = LV(c, i);
  const ds = c.dayStartOf(i);
  return Boolean(lv) && c.O[ds] < lv.h && c.O[ds] > lv.l;
});

// ---------- More indicators (added 4 Nov 2026) ----------
add('Momentum', 'rsi2Dip', 'RSI (2) dip bought in an uptrend', 'Connors style: the 2-bar RSI was under 10 and turns back over it while price is over the 50 EMA. A short dip in a rising market.', (c, i) => i > 0 && lt(c.rsi(2)[i - 1], 10) && ge(c.rsi(2)[i], 10) && gt(c.C[i], c.ema(50)[i]), { event: true });
add('Momentum', 'rsi2Low', 'RSI (2) under 10', 'A very short-term oversold reading. On its own it fights the move; pair it with a trend check.', (c, i) => lt(c.rsi(2)[i], 10));
add('Trend', 'diCross', '+DI crosses over -DI (ADX over 20)', 'Buyers take over the directional movement while a trend exists.', (c, i) => crossUp(c.dmi().pdi, c.dmi().ndi, i) && gt(c.dmi().adx[i], 20), { event: true });
add('Trend', 'adx25Rising', 'ADX over 25 and rising, buyers lead', 'A strong trend that is still getting stronger, with +DI over -DI.', (c, i) => i >= 3 && gt(c.dmi().adx[i], 25) && gt(c.dmi().adx[i], c.dmi().adx[i - 3]) && gt(c.dmi().pdi[i], c.dmi().ndi[i]));
add('Candles', 'haBull', 'Heikin-Ashi: two strong green bars', 'The last two Heikin-Ashi candles are green with no lower wick: a smooth push up.', (c, i) => {
  if (i < 1) return false;
  const h = c.ha();
  return [i, i - 1].every((k) => h[k].close > h[k].open && h[k].low >= Math.min(h[k].open, h[k].close) - 1e-9);
});
add('Candles', 'haFlip', 'Heikin-Ashi turns green', 'The first green Heikin-Ashi candle after two red ones.', (c, i) => {
  if (i < 2) return false;
  const h = c.ha();
  return h[i].close > h[i].open && h[i - 1].close < h[i - 1].open && h[i - 2].close < h[i - 2].open;
}, { event: true });
add('Volatility', 'bbSqueezeBreak', 'Bollinger squeeze, then a close above the upper band', 'The bands were the narrowest of the last 50 bars within the last 6 bars, and price now closes over the upper band.', (c, i) => {
  if (i < 56) return false;
  const w = c.bbWidth();
  const recent = w.slice(i - 6, i).filter(num);
  const past = w.slice(i - 56, i - 6).filter(num);
  return recent.length > 0 && past.length > 20 && Math.min(...recent) <= Math.min(...past) && gt(c.C[i], c.bb().upper[i]);
}, { event: true });
add('Volatility', 'donchian55', '55-bar high broken (about 4.5 hours)', 'The close beats the highest high of the 55 bars before: the turtle-style breakout.', (c, i) => i >= 55 && c.C[i] > Math.max(...c.H.slice(i - 55, i)));
add('Volume and VWAP', 'vwapBand1', 'Price over VWAP + 1 standard deviation', 'Holding over the first VWAP band: a trend day reading.', (c, i) => {
  const b = c.vwapBand();
  return Boolean(b) && num(b.vwap[i]) && num(b.sd[i]) && b.sd[i] > 0 && c.C[i] > b.vwap[i] + b.sd[i];
}, V);
add('Volume and VWAP', 'vwapBand2Fade', 'Back inside from under VWAP - 2 standard deviations', 'Price was under the lower 2-deviation band and closes back over it: a stretched fall snapping back.', (c, i) => {
  const b = c.vwapBand();
  return Boolean(b) && i > 0 && num(b.sd[i]) && num(b.sd[i - 1]) && c.C[i - 1] < b.vwap[i - 1] - 2 * b.sd[i - 1] && c.C[i] > b.vwap[i] - 2 * b.sd[i];
}, { ...V, event: true });
add('Volume and VWAP', 'aboveVwap2d', 'Above the 2-day anchored VWAP', "Price is over the VWAP anchored at yesterday's open: buyers of the last two days are in profit.", (c, i) => gt(c.C[i], c.vwap2d()?.[i]), V);
add('Volume and VWAP', 'mfiCross50', 'Money flow index crosses up through 50', 'The volume-weighted RSI turns to buying.', (c, i) => crossUp(c.mfi() || [], 50, i), { ...V, event: true });

// ---------- More settings of the main indicators (added 16 Nov 2026 for Lab > Learn, which tries them as filters) ----------
add('Momentum', 'rsiAbove60', 'RSI (14) above 60', 'Clear buying pressure, a step stronger than above 50.', (c, i) => gt(c.rsi(14)[i], 60));
add('Momentum', 'rsiNotStretched', 'RSI (14) under 75', 'Not yet overbought: some room left. For a put, RSI over 25.', (c, i) => lt(c.rsi(14)[i], 75));
add('Momentum', 'macdBothUp', 'MACD above its signal and above zero', 'Momentum is up on both counts: the line leads its signal and the 12 EMA is over the 26 EMA.', (c, i) => gt(c.macd().line[i], c.macd().signal[i]) && gt(c.macd().line[i], 0));
add('Trend', 'ema5Over13', 'EMA 5 above EMA 13', 'A quick pair of averages: the very short trend is up.', (c, i) => gt(c.ema(5)[i], c.ema(13)[i]));
add('Trend', 'ema9Rising', 'EMA 9 rising', 'The 9-bar average is higher than 2 bars ago.', (c, i) => i >= 2 && gt(c.ema(9)[i], c.ema(9)[i - 2]));
add('Volume and VWAP', 'vwapNear', 'Above VWAP but within 0.5 ATR of it', 'Over the day average and not stretched away from it: a calmer entry than a chase.', (c, i) => num(c.vwap()?.[i]) && num(c.atr[i]) && c.C[i] > c.vwap()[i] && c.C[i] - c.vwap()[i] < 0.5 * c.atr[i], V);
add('Volatility', 'bbPctB', 'Bollinger %B between 0.5 and 1', 'In the upper half of the bands but not beyond the upper band.', (c, i) => {
  const b = c.bb();
  const w = num(b.upper[i]) && num(b.lower[i]) ? b.upper[i] - b.lower[i] : 0;
  if (!(w > 0)) return false;
  const pb = (c.C[i] - b.lower[i]) / w;
  return pb >= 0.5 && pb <= 1;
});
add('Volatility', 'atrCalm', 'ATR not wild (under 1.5 times its 50-bar average)', 'Bars are not unusually big: stops are less likely to be hit by noise. No direction by itself.', (c, i) => {
  const a = c.atrFull();
  const avg = c.get('atr50', () => S.sma(a, 50));
  return num(a[i]) && num(avg[i]) && a[i] < 1.5 * avg[i];
});
add('Volatility', 'atrAwake', 'ATR above its 50-bar average', 'Bars are bigger than usual: the market is moving. No direction by itself.', (c, i) => {
  const a = c.atrFull();
  const avg = c.get('atr50', () => S.sma(a, 50));
  return num(a[i]) && num(avg[i]) && a[i] > avg[i];
});
add('Trend', 'supertrendSlowUp', 'Supertrend (14, 3) up', 'A slower supertrend is below price: fewer flips on a choppy day.', (c, i) => c.st(14, 3).dir[i] === 1);
add('Trend', 'adx30Up', 'ADX over 30 and +DI over -DI', 'A strong trend that buyers lead.', (c, i) => gt(c.dmi().adx[i], 30) && gt(c.dmi().pdi[i], c.dmi().ndi[i]));

// ---------- Options (added 16 Nov 2026): read from the option chain, only on days with saved real option prices, and live from the chain the trader reads ----------
// Near-the-money strikes only (the ones saved each evening), the nearest expiry for open interest, the contract the trader would buy for IV and greeks.
const O = { needs: 'options' };
const opt = (c) => c.opt;
add('Options', 'pcrAbove1', 'PCR above 1 (more puts written)', 'Put open interest is larger than call open interest near the money: option sellers are backing a floor. For a put: PCR under 1.', (c, i) => gt(opt(c)?.pcr[i], 1), O);
add('Options', 'pcrAbove12', 'PCR above 1.2', 'Clearly more puts than calls written near the money. For a put: PCR under 0.83.', (c, i) => gt(opt(c)?.pcr[i], 1.2), O);
add('Options', 'pcrRising', 'PCR rising', 'The PCR is higher than 3 bars ago (15 minutes): put writing is growing. For a put: PCR falling.', (c, i) => i >= 3 && gt(opt(c)?.pcr[i], opt(c)?.pcr[i - 3]), O);
add('Options', 'oiBacks', 'OI change backs this side', 'Since the open, more put OI than call OI has been added near the money (writers expect support). For a put: more call OI added.', (c, i) => gt(opt(c)?.oiEdge[i], 0), O);
add('Options', 'oiFresh', 'Fresh OI backs this side (15 min)', 'In the last 3 bars more put OI than call OI was added. For a put: more call OI.', (c, i) => gt(opt(c)?.oiEdge3[i], 0), O);
add('Options', 'belowMaxPain', 'Price below max pain', 'Max pain is the strike where option buyers lose the most at expiry; price is under it, so the pull, if any, is upward. For a put: price above it.', (c, i) => gt(opt(c)?.maxPain[i], c.C[i]), O);
add('Options', 'aboveMaxPain', 'Price above max pain', 'Price has already moved past max pain in this direction. For a put: price below it.', (c, i) => gt(c.C[i], opt(c)?.maxPain[i]), O);
add('Options', 'ivLow', 'IV percentile under 30 (cheap options)', 'The at-the-money implied volatility is lower than 70% of the readings of the last 20 saved days: premiums are cheap to buy. No direction by itself.', (c, i) => lt(opt(c)?.ivPct[i], 30), O);
add('Options', 'ivNotHigh', 'IV percentile under 60', 'Implied volatility is not high against the last 20 saved days, so a calm-down after the buy costs less. No direction by itself.', (c, i) => lt(opt(c)?.ivPct[i], 60), O);
add('Options', 'ivRising', 'IV rising', 'At-the-money implied volatility is higher than 3 bars ago: premiums are getting dearer, which helps a buyer. No direction by itself.', (c, i) => i >= 3 && gt(opt(c)?.atmIv[i], opt(c)?.atmIv[i - 3]), O);
add('Options', 'deltaNearMoney', 'Delta 0.4 to 0.6', 'The at-the-money option of this side moves about half as much as the index: it is near the money, not a lottery ticket.', (c, i) => ge(opt(c)?.delta[i], 0.4) && lt(opt(c)?.delta[i], 0.6), O);
add('Options', 'deltaStrong', 'Delta 0.5 or more', 'The strike bought is already a little in the money for this side, so the premium follows the index more closely.', (c, i) => ge(opt(c)?.delta[i], 0.5), O);
add('Options', 'thetaLow', 'Theta under 8% a day', 'A day of waiting costs the at-the-money option less than 8% of its premium. Avoids the last days before expiry, when time eats the premium fast. No direction by itself.', (c, i) => lt(opt(c)?.thetaPct[i], 8), O);
add('Options', 'thetaVeryLow', 'Theta under 5% a day', 'A day of waiting costs less than 5% of the premium: a contract with plenty of time left. No direction by itself.', (c, i) => lt(opt(c)?.thetaPct[i], 5), O);

// ---------- Chart patterns: the study's patterns, as events ----------
for (const t of TECHNIQUES) {
  CONDITIONS.push({
    key: `p_${t.key}`,
    label: t.label,
    group: 'Chart patterns',
    text: t.text,
    kind: 'event',
    needs: t.key === 'breadth' ? 'breadth' : t.needs || null,
    pattern: t.key,
    test: (c, i) => c.pat(t.key).has(i),
  });
}

// ---------- News (live shares only: the past headlines are not kept) ----------
add('News', 'newsAgrees', 'News points the same way', 'A recent headline favours this trade and the price has not sold it off.', (c, i) => c.newsAt(i) === 1, { needs: 'news' });

export const CONDITION_BY_KEY = new Map(CONDITIONS.map((c) => [c.key, c]));
export const catalog = () => CONDITIONS.map(({ key, label, group, text, kind, needs, pattern }) => ({ key, label, group, text, kind, needs, pattern: pattern || null, how: explainCondition({ key, label, group, text, kind, needs, pattern }) }));

/** Which optional data a chart has, and so which conditions can be used on it. */
export const usable = (cond, have) => !cond.needs || Boolean(have[cond.needs]);

/**
 * The chart, read for a call (d = 1) and a put (d = -1). Series are worked out on first use and kept.
 * @param bars   5-minute bars, oldest first
 * @param opts   breadth (share of the 50 stocks above yesterday close per bar), flow (traded value per bar), news (bar index -> 1, -1 or 0 for a call),
 *               only (the pattern keys to look for; all when null), from (the first bar index patterns are looked for), prep (an already prepared chart to reuse)
 */
export function buildChart(bars, { breadth = null, flow = null, news = null, options = null, only = null, from = 15, prep: given = null } = {}) {
  const prep = given || prepare(bars, breadth, flow);
  const have = { breadth: Boolean(breadth), flow: Boolean(prep.turn), news: Boolean(news), options: Boolean(options) };
  const found = findSignals(prep, { only: only || TECHNIQUES.map((t) => t.key), from, windows: false });
  const patterns = { 1: new Map(), '-1': new Map() };
  for (const s of found) {
    const side = s.side === 'CE' ? 1 : -1;
    const m = patterns[side];
    if (!m.has(s.technique)) m.set(s.technique, new Map());
    m.get(s.technique).set(s.i, s);
  }
  const chart = { bars, prep, have, patterns, atr: prep.atrAt, views: {}, truths: new Map() };
  for (const d of [1, -1]) chart.views[d] = makeView(chart, d, flow, news, options);
  return chart;
}

function makeView(chart, d, flow, news, options = null) {
  const { prep } = chart;
  const v = prep.views[d];
  const bars = v.bars;
  const memo = new Map();
  const get = (key, make) => {
    if (!memo.has(key)) memo.set(key, make());
    return memo.get(key);
  };
  const C = bars.map((b) => b.close);
  const O = bars.map((b) => b.open);
  const H = bars.map((b) => b.high);
  const L = bars.map((b) => b.low);
  const vol = flow && prep.turn ? flow.map((x) => (num(x) && x > 0 ? x : 0)) : null;
  const dayOf = chart.bars.map((b) => Math.floor((b.time + 19800) / 86400));
  const c = {
    d,
    opt: options ? optionView(options, d) : null, // the option chain as this side sees it (combos/optionData.js)
    bars,
    C,
    O,
    H,
    L,
    atr: prep.atrAt,
    flow: vol,
    breadth: v.breadth,
    get,
    ema: (n) => get(`ema${n}`, () => S.ema(C, n)),
    sma: (n) => get(`sma${n}`, () => S.sma(C, n)),
    hma: (n) => get(`hma${n}`, () => S.hma(C, n)),
    rsi: (n) => get(`rsi${n}`, () => S.rsi(C, n)),
    st: (p, m) => get(`st${p}_${m}`, () => S.supertrend(bars, p, m)),
    psar: () => get('psar', () => S.psar(bars)),
    dmi: () => get('dmi', () => S.dmi(bars)),
    aroon: () => get('aroon', () => S.aroon(bars)),
    ichi: () => get('ichi', () => S.ichimoku(bars)),
    vortex: () => get('vortex', () => S.vortex(bars)),
    linreg: () => get('linreg', () => S.linreg(C, 20)),
    trix: () => get('trix', () => S.trix(C)),
    macd: () => get('macd', () => S.macd(C)),
    stoch: () => get('stoch', () => S.stochastic(bars)),
    cci: () => get('cci', () => S.cci(bars)),
    willr: () => get('willr', () => S.williamsR(bars)),
    ao: () => get('ao', () => S.awesome(bars)),
    ult: () => get('ult', () => S.ultimate(bars)),
    bb: () => get('bb', () => S.bollinger(C)),
    bbWidth: () => get('bbw', () => {
      const b = c.bb();
      return b.mid.map((m, i) => (num(m) && num(b.upper[i]) && m !== 0 ? (b.upper[i] - b.lower[i]) / Math.abs(m) : null));
    }),
    kc: () => get('kc', () => S.keltner(bars)),
    atrFull: () => get('atrFull', () => S.atr(bars, 14)),
    vwap: () => v.vwap,
    obv: () => (vol ? get('obv', () => S.obv(bars, vol)) : null),
    obvAvg: () => (vol ? get('obvAvg', () => S.sma(c.obv(), 20)) : null),
    cmf: () => (vol ? get('cmf', () => S.cmf(bars, vol)) : null),
    mfi: () => (vol ? get('mfi', () => S.mfi(bars, vol)) : null),
    force: () => (vol ? get('force', () => S.force(bars, vol)) : null),
    turnAvg: (i) => prep.turnAvg?.[i] ?? null,
    heavy: (i, mult) => Boolean(vol) && num(prep.turnAvg?.[i]) && prep.turnAvg[i] > 0 && num(prep.turn[i]) && prep.turn[i] >= mult * prep.turnAvg[i],
    dayOpen: (i) => bars[prep.dayStart[i]].open,
    prevClose: (i) => (prep.dayStart[i] > 0 ? bars[prep.dayStart[i] - 1].close : null),
    prevHigh: (i) => get('prevHigh', () => {
      const out = [];
      let cur = null;
      let prev = null;
      for (let k = 0; k < bars.length; k++) {
        if (k === 0 || dayOf[k] !== dayOf[k - 1]) {
          prev = cur;
          cur = -Infinity;
        }
        cur = Math.max(cur, bars[k].high);
        out.push(prev);
      }
      return out;
    })[i],
    dayMean: () => get('dayMean', () => {
      let sum = 0;
      return bars.map((b, k) => {
        if (k === prep.dayStart[k]) sum = 0;
        sum += b.close;
        return sum / (k - prep.dayStart[k] + 1);
      });
    }),
    dayHigh: () => get('dayHigh', () => {
      let m = -Infinity;
      return bars.map((b, k) => {
        if (k === prep.dayStart[k]) m = -Infinity;
        m = Math.max(m, b.high);
        return m;
      });
    }),
    orHigh: (i) => {
      const ds = prep.dayStart[i];
      if (i < ds + 3) return null; // the range is the first 3 bars (09:15 to 09:30)
      return Math.max(bars[ds].high, bars[ds + 1].high, bars[ds + 2].high);
    },
    dayStartOf: (i) => prep.dayStart[i],
    // choppiness index over 14 bars: 100 near a sideways market, under 40 a clean trend
    chop: () => get('chop', () => {
      const tr = S.trueRange(bars);
      return bars.map((_, i) => {
        if (i < 14) return null;
        let sum = 0;
        let hi = -Infinity;
        let lo = Infinity;
        for (let k = i - 13; k <= i; k++) {
          sum += tr[k];
          hi = Math.max(hi, H[k]);
          lo = Math.min(lo, L[k]);
        }
        return hi > lo ? (100 * Math.log10(sum / (hi - lo))) / Math.log10(14) : null;
      });
    }),
    // today's range so far over the average range of the 5 days before (null until 5 days are known)
    roomRatio: () => get('room', () => {
      const ranges = new Map();
      bars.forEach((b, k) => {
        const d = dayOf[k];
        const r = ranges.get(d) || { hi: -Infinity, lo: Infinity };
        r.hi = Math.max(r.hi, H[k]);
        r.lo = Math.min(r.lo, L[k]);
        ranges.set(d, r);
      });
      const days = [...ranges.keys()];
      const out = [];
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = 0; k < bars.length; k++) {
        if (k === prep.dayStart[k]) {
          hi = -Infinity;
          lo = Infinity;
        }
        hi = Math.max(hi, H[k]);
        lo = Math.min(lo, L[k]);
        const at = days.indexOf(dayOf[k]);
        const past = days.slice(Math.max(0, at - 5), at).map((d) => ranges.get(d).hi - ranges.get(d).lo);
        out.push(past.length >= 5 ? (hi - lo) / (past.reduce((a, b) => a + b, 0) / past.length) : null);
      }
      return out;
    }),
    minutes: (i) => get('minutes', () => chart.bars.map((b) => istParts(new Date((b.time + 300) * 1000)).minutes))[i],
    // yesterday's pivot, CPR, Camarilla and value area for bar i's day (study/levels.js), null on the first day of the data
    lv: (i) => v.levels?.[i] ?? null,
    ha: () => get('ha', () => S.heikinAshi(bars)),
    vwapBand: () => (vol ? get('vwapBand', () => S.anchoredVwap(bars, vol, dayOf)) : null),
    // VWAP anchored at yesterday's first bar: today's bars weigh in with all of yesterday's
    vwap2d: () => (vol ? get('vwap2d', () => {
      const out = new Array(bars.length).fill(null);
      const starts = [...new Set(prep.dayStart)];
      for (let n = 1; n < starts.length; n++) {
        const to = n + 1 < starts.length ? starts[n + 1] : bars.length;
        let w = 0;
        let pv = 0;
        for (let k = starts[n - 1]; k < to; k++) {
          if (vol[k] > 0) {
            w += vol[k];
            pv += ((bars[k].high + bars[k].low + bars[k].close) / 3) * vol[k];
          }
          if (k >= starts[n]) out[k] = w > 0 ? pv / w : null;
        }
      }
      return out;
    }) : null),
    pat: (key) => chart.patterns[d].get(key) || new Map(),
    newsAt: (i) => (news ? (news(i) || 0) * d : 0),
  };
  return c;
}

/** Does `cond` hold on bar i, for a call (d = 1) or a put (d = -1)? Cached per chart. */
export function holds(chart, cond, d, i) {
  const key = `${cond.key}|${d}`;
  let arr = chart.truths.get(key);
  if (!arr) {
    arr = new Uint8Array(chart.bars.length);
    const view = chart.views[d];
    for (let k = 0; k < arr.length; k++) {
      let ok = false;
      try {
        ok = Boolean(cond.test(view, k));
      } catch {
        ok = false;
      }
      arr[k] = ok ? 1 : 0;
    }
    chart.truths.set(key, arr);
  }
  return arr[i] === 1;
}

export { BUFFER_ATR };
