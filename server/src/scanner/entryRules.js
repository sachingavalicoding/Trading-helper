import { istParts } from '../market/marketHours.js';

// Extra entry checks for the share auto trader, added 11 Nov 2026 after five losing days in a row. Each one is a switch in
// Account > Entries > Shares and in the Shares study's "Test the new entry rules", so they can be judged on saved days first.
// 0 / false means off. `minStopPct` is the old fixed 0.5% rule, now a setting.
export const DEFAULT_SHARE_RULES = Object.freeze({
  marketAgree: false, // buy only when Nifty 50 trends up (VWAP and EMA 9/21 on 5-minute bars), sell only when it trends down; a flat Nifty = no trade
  minVsNifty: 0, // the share must be at least this % stronger than Nifty 50 today for a buy (weaker for a sell)
  minRelVol: 0, // volume of the last 15 minutes must be at least this many times normal for that time of day
  confirmBar: false, // do not buy on the breaking bar: wait for a 5-minute bar to close past the entry (up to 2 bars), then buy
  noChaseR: 0.5, // skip when the price has already run this many risks past the entry (the old fixed 0.5R)
  minStopPct: 0.5, // skip an idea whose stop is closer than this % of the entry
  stopAfterLosses: 0, // no new share trade today after this many losing auto trades
  target: 0, // sell a share trade once its profit reaches this many rupees, in place of the profit ladder; 0 = the ladder (Account)
});

export const RULE_LABELS = {
  marketAgree: 'Nifty must agree',
  minVsNifty: 'Stronger than Nifty',
  minRelVol: 'Volume above normal',
  confirmBar: 'Wait for a 5-minute close',
  noChaseR: 'Do not chase',
  minStopPct: 'Smallest stop',
  stopAfterLosses: 'Stop after losses',
  target: 'Fixed profit target',
};

/** The user's rules with every missing one filled from the defaults. */
export function shareRulesOf(saved) {
  const out = { ...DEFAULT_SHARE_RULES };
  for (const k of Object.keys(DEFAULT_SHARE_RULES)) if (saved?.[k] != null) out[k] = saved[k];
  return out;
}

/**
 * Why an idea fails one of the market rules, or null. `facts` are what the scanner knew when it raised the idea:
 * { niftyTrend (-1, 0, 1 or null), relStrength (share % change minus Nifty's), relVol }. A missing reading never blocks.
 */
export function ruleBlock(rules, facts, side) {
  const d = side === 'BUY' ? 1 : -1;
  const f = facts || {};
  if (rules.marketAgree && f.niftyTrend != null && d * f.niftyTrend <= 0) return f.niftyTrend === 0 ? 'Nifty 50 is moving sideways, so a share has no market behind it' : `Nifty 50 is trending ${f.niftyTrend > 0 ? 'up' : 'down'}, against this ${side === 'BUY' ? 'buy' : 'sell'}`;
  if (rules.minVsNifty > 0 && f.relStrength != null && d * f.relStrength < rules.minVsNifty) return `the share is only ${(d * f.relStrength).toFixed(2)}% ${d > 0 ? 'stronger' : 'weaker'} than Nifty 50, under the ${rules.minVsNifty}% you asked for`;
  if (rules.minRelVol > 0 && f.relVol != null && f.relVol < rules.minRelVol) return `volume is ${f.relVol.toFixed(1)}x normal for this time, under the ${rules.minRelVol}x you asked for`;
  return null;
}

export const CONFIRM_BARS = 2; // how many 5-minute closes the confirmation waits for before giving up

/**
 * Wait-for-a-close entry on 1-minute candles. The idea was raised during bar `from` (its time is c1[from].time). Look at the
 * 5-minute bar it was raised in and then the next one: the first that closes past the idea's entry, without the stop being touched
 * and without having run more than `noChaseR` risks, is the entry, at its close. Returns { index, price, time } of that last
 * 1-minute bar, or { dropped: reason }. With too few bars yet, { waiting: true }.
 */
export function confirmEntry(c1, from, idea, { noChaseR = 0.5, bars = CONFIRM_BARS } = {}) {
  const d = idea.side === 'BUY' ? 1 : -1;
  const risk = Math.abs(idea.entry - idea.stopLoss);
  const startSlot = Math.floor(c1[from].time / 300);
  let slot = startSlot;
  let j = from;
  while (slot < startSlot + bars) {
    const end = (slot + 1) * 300; // the bar's close time
    let last = null;
    for (; j + 1 < c1.length && c1[j + 1].time < end; j++) {
      const b = c1[j + 1];
      if (d * ((d > 0 ? b.low : b.high) - idea.stopLoss) <= 0) return { dropped: 'the stop was touched while waiting for a 5-minute close' };
      last = j + 1;
    }
    if (j + 1 >= c1.length) return { waiting: true };
    const closeBar = last ?? j;
    const close = c1[closeBar].close;
    if (d * (close - idea.entry) >= 0) {
      if (risk && (d * (close - idea.entry)) / risk > noChaseR) return { dropped: `the 5-minute close was already ${((d * (close - idea.entry)) / risk).toFixed(2)}R past the entry` };
      return { index: closeBar, price: close, time: c1[closeBar].time };
    }
    slot += 1;
  }
  return { dropped: `no 5-minute bar closed ${d > 0 ? 'above' : 'below'} the entry within ${bars * 5} minutes` };
}

/** Minute of the day (IST) of a unix time in seconds. */
export const minuteOf = (t) => istParts(new Date(t * 1000)).minutes;
