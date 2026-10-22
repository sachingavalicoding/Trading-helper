// Indian number formatting: ₹1,00,000.00 grouping, and lakh / crore shorthands.
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const formatINR = (v) => (isNum(v) ? inr.format(v) : '—');
export const formatPrice = (v) => (isNum(v) ? num2.format(v) : '—');
export const formatInt = (v) => (isNum(v) ? int.format(v) : '—');

/** ₹1.25 Cr, ₹3.40 L, ₹45,200 */
export function formatCompactINR(v) {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹${int.format(abs)}`;
}

/** Volumes: 1.2 Cr, 34.5 L, 12,300 */
export function formatQtyCompact(v) {
  if (!isNum(v)) return '—';
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  return int.format(v);
}

/** Signed P&L: +₹1,234.50 / -₹56.00 */
export function formatPnl(v) {
  if (!isNum(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${inr.format(Math.abs(v))}`;
}

export function formatPct(v) {
  if (!isNum(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export const pnlClass = (v) => (!isNum(v) || v === 0 ? 'text-muted' : v > 0 ? 'text-up' : 'text-down');

export function formatTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
