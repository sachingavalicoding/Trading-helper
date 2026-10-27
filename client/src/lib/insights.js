const pct = (from, to) => (from ? ((to - from) / from) * 100 : null);

/**
 * Quick reads of one live tick for the stocks grid:
 *  - rangePos: where the price sits between today's low (0) and high (1)
 *  - vsVwapPct: how far above or below the day's average traded price
 *  - gapPct: open versus yesterday's close, fromOpenPct: price versus today's open
 *  - mood: Strong (above VWAP and open, near the high), Weak (the mirror image) or Mixed
 */
export function insightsOf(t) {
  if (!t?.ltp) return null;
  const span = t.high - t.low;
  const rangePos = span > 0 ? (t.ltp - t.low) / span : null;
  const vsVwapPct = t.atp ? pct(t.atp, t.ltp) : null;
  const strong = t.atp && t.open && rangePos != null && t.ltp > t.atp && t.ltp > t.open && rangePos >= 0.65;
  const weak = t.atp && t.open && rangePos != null && t.ltp < t.atp && t.ltp < t.open && rangePos <= 0.35;
  return {
    rangePos,
    rangePct: pct(t.low, t.high),
    vsVwapPct,
    gapPct: t.prevClose && t.open ? pct(t.prevClose, t.open) : null,
    fromOpenPct: t.open ? pct(t.open, t.ltp) : null,
    mood: strong ? 'Strong' : weak ? 'Weak' : 'Mixed',
  };
}

/** Columns the grid can sort by: the value to sort on for one row `{ tick, insight, news }`. */
export const SORT_KEYS = {
  symbol: (r) => r.stock.symbol,
  ltp: (r) => r.tick?.ltp,
  change: (r) => r.tick?.changePct,
  range: (r) => r.insight?.rangePos,
  vwap: (r) => r.insight?.vsVwapPct,
  gap: (r) => r.insight?.gapPct,
  volume: (r) => r.tick?.volume,
  news: (r) => (r.news ? (r.news.label === 'BULLISH' ? 1 : -1) * Math.abs(r.news.net) : null),
};

/** Sort rows by a column, rows without a value always last. */
export function sortRows(rows, key, dir = 'desc') {
  const get = SORT_KEYS[key] || SORT_KEYS.symbol;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return a.stock.symbol.localeCompare(b.stock.symbol);
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') return sign * x.localeCompare(y);
    return sign * (x - y) || a.stock.symbol.localeCompare(b.stock.symbol);
  });
}
