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

/** The one download button: it fetches the days that are not saved yet and today so far, and drops the oldest days beyond three months. */
export const SYNC_LABEL = 'Update to now';

/** "Today saved up to 13:42" from the time (seconds) of the newest saved candle of today, or what to do when today is not saved. */
export function liveText(liveAt) {
  if (!liveAt) return 'Today is not saved yet. Press the button during or after the session to add it.';
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date((liveAt + 60) * 1000));
  return `Today saved up to ${t}. Press the button again for the later minutes.`;
}

/** Progress of a running download as a 0-100 number. */
export function jobPercent(job) {
  if (!job || !job.total) return 0;
  return Math.min(100, Math.round((job.done / job.total) * 100));
}
