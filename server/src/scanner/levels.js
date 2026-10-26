import { swings } from '../signals/indicators.js';
import { roundToTick } from '../utils/money.js';

// "Swing high · Day's high" -> "swing high / day's high" for use mid-sentence.
export const levelName = (kind) => kind.split(' · ').map((k) => (k === k.toUpperCase() ? k : k[0].toLowerCase() + k.slice(1))).join(' / ');

/**
 * Price levels that tend to matter: recent swing highs and lows, the previous day's high and
 * low, today's high, low and open, and VWAP. Levels within 0.15% of each other are merged.
 * Returns [{ price, kind }] sorted by price, lowest first.
 */
export function buildLevels({ c5, tick, vwap, pdh, pdl, month = null, pivots = null }) {
  const { highs, lows } = swings(c5.slice(-80));
  const raw = [
    ...highs.map((price) => ({ price, kind: 'Swing high' })),
    ...lows.map((price) => ({ price, kind: 'Swing low' })),
    { price: tick.high, kind: "Day's high" },
    { price: tick.low, kind: "Day's low" },
    { price: tick.open, kind: "Day's open" },
  ];
  if (pdh != null) raw.push({ price: pdh, kind: "Previous day's high" });
  if (pdl != null) raw.push({ price: pdl, kind: "Previous day's low" });
  if (pivots) raw.push({ price: pivots.tc, kind: 'CPR top' }, { price: pivots.bc, kind: 'CPR bottom' }, { price: pivots.r1, kind: 'Pivot R1' }, { price: pivots.s1, kind: 'Pivot S1' });
  if (month) raw.push({ price: month.high, kind: 'Month high' }, { price: month.low, kind: 'Month low' });
  if (vwap) raw.push({ price: vwap, kind: 'VWAP' });
  const merged = [];
  for (const l of raw.filter((x) => Number.isFinite(x.price)).sort((a, b) => a.price - b.price)) {
    const prev = merged.at(-1);
    if (prev && Math.abs(l.price - prev.price) / prev.price < 0.0015) {
      if (!prev.kind.includes(l.kind)) prev.kind += ` · ${l.kind}`;
    } else merged.push({ ...l });
  }
  return merged.map((l) => ({ price: roundToTick(l.price), kind: l.kind }));
}
