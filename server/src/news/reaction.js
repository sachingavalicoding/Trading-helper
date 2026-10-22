const AGREE_PCT = 0.3;
const MIN_AGE_MS = 5 * 60 * 1000;

/**
 * Did the price do what the headline says? Compares the price when the news came out with the
 * price now.
 *  AGREES   price moved the way the news points (the market believes it)
 *  FADING   price moved the other way ("sell the news": good news sold, bad news bought)
 *  FLAT     no real reaction yet
 *  TOO_EARLY / UNKNOWN  not enough information
 * `c1` is 1-minute candles, oldest first, times in UTC epoch seconds.
 */
export function reactionTo({ label, publishedAt, c1, ltp, now = new Date() }) {
  if (label === 'NEUTRAL') return null;
  const at = new Date(publishedAt).getTime();
  if (now.getTime() - at < MIN_AGE_MS) return { state: 'TOO_EARLY', movePct: null };
  if (!c1?.length || ltp == null) return { state: 'UNKNOWN', movePct: null };
  const t = Math.floor(at / 1000);
  let base = null;
  for (let i = c1.length - 1; i >= 0; i--) {
    if (c1[i].time <= t) {
      base = c1[i].close;
      break;
    }
  }
  if (base == null) return { state: 'UNKNOWN', movePct: null };
  const movePct = ((ltp - base) / base) * 100;
  const d = label === 'BULLISH' ? 1 : -1;
  const aligned = d * movePct;
  const state = aligned >= AGREE_PCT ? 'AGREES' : aligned <= -AGREE_PCT ? 'FADING' : 'FLAT';
  return { state, movePct: Math.round(movePct * 100) / 100 };
}
