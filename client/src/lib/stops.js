// The ways an options entry can place its stop (Account > Entries), described the same on the settings screen, in the study and in Review.

export const STOP_MODES = [
  { value: 'chart', label: 'Calculated', hint: 'The stop sits at the chart level where the idea is proven wrong. A level that is too far away skips the trade.' },
  { value: 'cap', label: 'Calculated, capped', hint: 'The chart level, but never further than the ATRs you pick: a far level is pulled in instead of skipping the trade.' },
  { value: 'atr', label: 'ATR', hint: 'Always the ATRs you pick from the entry (one ATR is about one 5-minute swing), whatever the chart shows.' },
  { value: 'fixed', label: 'Fixed', hint: 'Always the same number of Nifty points from the entry.' },
];

export const STOP_ATRS = [0.8, 1, 1.5, 2, 2.5];
export const STOP_POINTS = [15, 20, 25, 30, 40, 50, 60, 80];

/** The stop rule a study or the settings used, in words. */
export function stopRuleText(rule) {
  const mode = rule?.mode ?? 'chart';
  if (mode === 'cap') return `stop is the chart level, pulled in to ${rule.k} ATR when it is further (checked on a closed 1-minute candle)`;
  if (mode === 'atr') return `stop is ${rule.k} ATR from the entry (checked on a closed 1-minute candle)`;
  if (mode === 'fixed') return `stop is ${rule.points} Nifty points from the entry (checked on a closed 1-minute candle)`;
  return 'stop is the chart level on a closed 1-minute candle';
}

/** What the stop setting is, as a short phrase for a summary line. */
export function stopShort(s) {
  if (s.patternStopMode === 'cap') return `chart stop, capped at ${s.patternStopAtr} ATR`;
  if (s.patternStopMode === 'atr') return `${s.patternStopAtr} ATR stop`;
  if (s.patternStopMode === 'fixed') return `${s.patternStopPoints} point stop`;
  return 'chart stop';
}

/** One what-if stop of a Review signal in words: "30 pts: 30 points, hit after 12 min" or "held for the hour". */
export function whatIfText(w) {
  const dist = `${Math.round(w.pts)} points`;
  return w.hitAfter == null ? `${dist}, held for the hour` : `${dist}, hit after ${w.hitAfter} min`;
}
