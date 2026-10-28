/** "38.2 MB", "820 KB" from a byte count. */
export function sizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "28 Oct 2025" from a "2025-10-28" day string. */
export function dayText(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** What the Data tab says about the saved candles, in one line. */
export function savedText(saved) {
  if (!saved || !saved.days) return 'Nothing saved yet.';
  return `${saved.symbols} symbols, ${saved.days} trading days, ${dayText(saved.from)} to ${dayText(saved.to)}, ${sizeText(saved.bytes)}.`;
}

/** The one download button: it fetches only the days that are not saved yet. */
export const SYNC_LABEL = 'Download last 3 months';

/** Progress of a running download as a 0-100 number. */
export function jobPercent(job) {
  if (!job || !job.total) return 0;
  return Math.min(100, Math.round((job.done / job.total) * 100));
}
