// Filters for the scanner list: minimum score and time of day (IST).
export const TIME_WINDOWS = [
  { value: 'ALL', label: 'All day', from: 0, to: 1440 },
  { value: 'AM', label: '9:30-11:30', from: 9 * 60 + 30, to: 11 * 60 + 30 },
  { value: 'MID', label: '11:30-1:30', from: 11 * 60 + 30, to: 13 * 60 + 30 },
  { value: 'PM', label: '1:30-3:15', from: 13 * 60 + 30, to: 15 * 60 + 15 },
];

/** Minutes after midnight in India for an ISO time. */
export const istMinutes = (iso) => {
  const d = new Date(iso);
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
};

/** Keep ideas at or above `minScore` and, when they carry a time, raised inside the window. */
export function passesFilter(item, { minScore = 0, window: win = 'ALL' }, timeOf = (i) => i.openedAt) {
  if (item.score != null && item.score < minScore) return false;
  const w = TIME_WINDOWS.find((x) => x.value === win);
  const t = timeOf(item);
  if (!w || win === 'ALL' || !t) return true;
  const m = istMinutes(t);
  return m >= w.from && m < w.to;
}
