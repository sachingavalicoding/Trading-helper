import { prepare, findSignals, TECHNIQUES, BUFFER_ATR } from '../study/patterns.js';
import { istParts } from '../market/marketHours.js';
import * as S from './series.js';

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

export const GROUPS = ['Trend', 'Momentum', 'Volatility', 'Volume and VWAP', 'Candles', 'Market', 'Time of day', 'Chart patterns', 'News'];

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
export const catalog = () => CONDITIONS.map(({ key, label, group, text, kind, needs, pattern }) => ({ key, label, group, text, kind, needs, pattern: pattern || null }));

/** Which optional data a chart has, and so which conditions can be used on it. */
export const usable = (cond, have) => !cond.needs || Boolean(have[cond.needs]);

/**
 * The chart, read for a call (d = 1) and a put (d = -1). Series are worked out on first use and kept.
 * @param bars   5-minute bars, oldest first
 * @param opts   breadth (share of the 50 stocks above yesterday close per bar), flow (traded value per bar), news (bar index -> 1, -1 or 0 for a call),
 *               only (the pattern keys to look for; all when null), from (the first bar index patterns are looked for), prep (an already prepared chart to reuse)
 */
export function buildChart(bars, { breadth = null, flow = null, news = null, only = null, from = 15, prep: given = null } = {}) {
  const prep = given || prepare(bars, breadth, flow);
  const have = { breadth: Boolean(breadth), flow: Boolean(prep.turn), news: Boolean(news) };
  const found = findSignals(prep, { only: only || TECHNIQUES.map((t) => t.key), from, windows: false });
  const patterns = { 1: new Map(), '-1': new Map() };
  for (const s of found) {
    const side = s.side === 'CE' ? 1 : -1;
    const m = patterns[side];
    if (!m.has(s.technique)) m.set(s.technique, new Map());
    m.get(s.technique).set(s.i, s);
  }
  const chart = { bars, prep, have, patterns, atr: prep.atrAt, views: {}, truths: new Map() };
  for (const d of [1, -1]) chart.views[d] = makeView(chart, d, flow, news);
  return chart;
}

function makeView(chart, d, flow, news) {
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
    minutes: (i) => get('minutes', () => chart.bars.map((b) => istParts(new Date((b.time + 300) * 1000)).minutes))[i],
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
