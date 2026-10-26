import { istParts, istTimeOn, CLOSE_MIN } from '../market/marketHours.js';

// Nifty 50 index options only. A contract is named after what it is, so the symbol alone says everything:
// NIFTY-20261103-24500-CE = the 3 Nov 2026 expiry, strike 24500, call. The order engine, wallet and charts treat it like any
// other symbol; only the pricing, margin and charges look inside it.
export const UNDERLYING = 'NIFTY 50';
export const STRIKE_STEP = 50;
export const DEFAULT_LOT_SIZE = 65; // NSE has changed the Nifty lot more than once; set NIFTY_LOT_SIZE if it changes again (live contracts carry their own)
export const DEFAULT_EXPIRY_WEEKDAY = 2; // Nifty weekly options expire on Tuesdays (0 = Sunday)
export const OPTION_TICK = 0.05;

const RE = /^NIFTY-(\d{4})(\d{2})(\d{2})-(\d{3,6})-(CE|PE)$/;

export const optionSymbol = ({ expiry, strike, type }) => `NIFTY-${String(expiry).replaceAll('-', '')}-${strike}-${type}`;

/** { expiry: 'YYYY-MM-DD', strike, type: 'CE'|'PE' } or null when `symbol` is not a Nifty option. */
export function parseOptionSymbol(symbol) {
  const m = RE.exec(String(symbol || ''));
  return m ? { expiry: `${m[1]}-${m[2]}-${m[3]}`, strike: Number(m[4]), type: m[5] } : null;
}

export const isOptionSymbol = (symbol) => RE.test(String(symbol || ''));

export const atmStrike = (spot, step = STRIKE_STEP) => Math.round(spot / step) * step;

/** "NIFTY 24500 CE · 3 Nov" for screens. */
export function optionLabel(symbol) {
  const o = parseOptionSymbol(symbol);
  if (!o) return symbol;
  const [y, m, d] = o.expiry.split('-').map(Number);
  const mon = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `NIFTY ${o.strike} ${o.type} · ${d} ${mon}`;
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
