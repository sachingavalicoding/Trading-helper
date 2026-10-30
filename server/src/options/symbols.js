import { istParts, istTimeOn, CLOSE_MIN } from '../market/marketHours.js';

// Nifty 50 and Sensex index options. A contract is named after what it is, so the symbol alone says everything:
// NIFTY-20261103-24500-CE = the 3 Nov 2026 Nifty expiry, strike 24500, call (SENSEX-20261105-82000-PE is a Sensex put). The order engine,
// wallet and charts treat it like any other symbol; only the pricing, margin and charges look inside it.
export const UNDERLYING = 'NIFTY 50';
export const STRIKE_STEP = 50;
export const DEFAULT_LOT_SIZE = 65; // NSE has changed the Nifty lot more than once; set NIFTY_LOT_SIZE if it changes again (live contracts carry their own)
export const DEFAULT_EXPIRY_WEEKDAY = 2; // Nifty weekly options expire on Tuesdays (0 = Sunday)
export const OPTION_TICK = 0.05;

/**
 * The indexes whose options the app trades. `lot` and `expiryWeekday` are only the defaults for the sample feed and for a study: the live
 * contracts carry their own lot size and expiry, and NIFTY_LOT_SIZE / SENSEX_LOT_SIZE / *_EXPIRY_WEEKDAY in the server settings override these.
 */
export const INDEXES = {
  NIFTY: { key: 'NIFTY', symbol: UNDERLYING, name: 'Nifty 50', short: 'Nifty', upstoxKey: 'NSE_INDEX|Nifty 50', strikeStep: STRIKE_STEP, lot: DEFAULT_LOT_SIZE, expiryWeekday: DEFAULT_EXPIRY_WEEKDAY },
  SENSEX: { key: 'SENSEX', symbol: 'SENSEX', name: 'Sensex', short: 'Sensex', upstoxKey: 'BSE_INDEX|SENSEX', strikeStep: 100, lot: 20, expiryWeekday: 4 },
};
export const INDEX_KEYS = Object.keys(INDEXES);
export const DEFAULT_INDEX = 'NIFTY';
export const isIndexKey = (key) => Object.hasOwn(INDEXES, key);
/** 'NIFTY' | 'SENSEX' for the index a chart symbol belongs to ('NIFTY 50' -> 'NIFTY'), else null. */
export const indexKeyOf = (symbol) => INDEX_KEYS.find((k) => INDEXES[k].symbol === symbol) ?? null;
/** The default lot size of an index, from the server settings (`config.niftyLotSize`, `config.sensexLotSize`) when given. */
export const lotSizeOf = (index, config = {}) => (index === 'SENSEX' ? config?.sensexLotSize : config?.niftyLotSize) ?? INDEXES[index]?.lot ?? DEFAULT_LOT_SIZE;
export const expiryWeekdayOf = (index, config = {}) => (index === 'SENSEX' ? config?.sensexExpiryWeekday : config?.niftyExpiryWeekday) ?? INDEXES[index]?.expiryWeekday ?? DEFAULT_EXPIRY_WEEKDAY;

const RE = /^(NIFTY|SENSEX)-(\d{4})(\d{2})(\d{2})-(\d{3,6})-(CE|PE)$/;

export const optionSymbol = ({ expiry, strike, type, index = DEFAULT_INDEX }) => `${index}-${String(expiry).replaceAll('-', '')}-${strike}-${type}`;

/** { index: 'NIFTY'|'SENSEX', expiry: 'YYYY-MM-DD', strike, type: 'CE'|'PE' } or null when `symbol` is not an index option. */
export function parseOptionSymbol(symbol) {
  const m = RE.exec(String(symbol || ''));
  return m ? { index: m[1], expiry: `${m[2]}-${m[3]}-${m[4]}`, strike: Number(m[5]), type: m[6] } : null;
}

export const isOptionSymbol = (symbol) => RE.test(String(symbol || ''));

export const atmStrike = (spot, step = STRIKE_STEP) => Math.round(spot / step) * step;

/** "NIFTY 24500 CE · 3 Nov" (or "SENSEX 82000 CE · 6 Nov") for screens. */
export function optionLabel(symbol) {
  const o = parseOptionSymbol(symbol);
  if (!o) return symbol;
  const [y, m, d] = o.expiry.split('-').map(Number);
  const mon = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${o.index} ${o.strike} ${o.type} · ${d} ${mon}`;
}

/** The weekly expiry dates (IST, YYYY-MM-DD) from today on, skipping holidays by moving to the day before. */
export function weeklyExpiries(now = new Date(), { count = 3, weekday = DEFAULT_EXPIRY_WEEKDAY, holidays = [] } = {}) {
  const out = [];
  const { dateKey } = istParts(now);
  const [y, m, d] = dateKey.split('-').map(Number);
  for (let i = 0; out.length < count && i < 60; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    if (day.getUTCDay() !== weekday) continue;
    let k = day;
    while (holidays.includes(k.toISOString().slice(0, 10)) || k.getUTCDay() === 0 || k.getUTCDay() === 6) k = new Date(k.getTime() - 86400000);
    const key = k.toISOString().slice(0, 10);
    if (key >= dateKey && !out.includes(key)) out.push(key);
  }
  return out;
}

/** The moment a contract stops trading: 15:30 IST on its expiry date. */
export const expiryInstant = (expiry) => istTimeOn(new Date(`${expiry}T06:00:00Z`), CLOSE_MIN);

/** Years left to expiry, for the pricing model. Never zero, so a contract about to expire still prices. */
export function yearsToExpiry(expiry, now = new Date()) {
  return Math.max(expiryInstant(expiry).getTime() - now.getTime(), 15 * 60000) / (365 * 24 * 3600 * 1000);
}

/**
 * The expiry to buy: the nearest one at least `minDays` calendar days after today (IST). Buying on expiry day is a bet on the
 * last few hours, where the premium melts and moves wildly, so by default the next week's contract is used on that day.
 */
export function chooseExpiry(expiries, now = new Date(), { minDays = 1 } = {}) {
  const [y, m, d] = istParts(now).dateKey.split('-').map(Number);
  const earliest = new Date(Date.UTC(y, m - 1, d + minDays)).toISOString().slice(0, 10);
  return expiries.find((e) => e >= earliest) || expiries.at(-1) || null;
}
