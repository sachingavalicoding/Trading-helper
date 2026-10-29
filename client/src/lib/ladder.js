// The profit ladder as the user types it: rows of "when the profit reaches X, the stop keeps Y".
// Above a row the stop follows (X - Y) behind the best profit, until the next row takes over.

export const MAX_ROWS = 8;
const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

/** Rows for the form, as text so a half-typed number is kept. */
export const rowsFromRules = (rules) => (rules?.savedSteps ?? rules?.steps ?? []).map((s) => ({ at: String(s.at), keep: String(s.keep) }));

/** The rows as numbers, ready to save. Blank rows are dropped. */
export const stepsOf = (rows) => rows.filter((r) => r.at !== '' || r.keep !== '').map((r) => ({ at: Number(r.at), keep: Number(r.keep) }));

/** What is wrong with the rows, or null. */
export function rowsProblem(rows) {
  const steps = stepsOf(rows);
  if (steps.length > MAX_ROWS) return `Use at most ${MAX_ROWS} rows`;
  for (const [i, s] of steps.entries()) {
    if (!Number.isFinite(s.at) || !Number.isFinite(s.keep) || s.at <= 0 || s.keep < 0) return `Row ${i + 1}: enter the profit and the lock as numbers`;
    if (s.at <= s.keep) return `Row ${i + 1}: the lock must be less than the profit that sets it`;
    if (i > 0 && !(s.at > steps[i - 1].at && s.keep > steps[i - 1].keep)) return `Row ${i + 1}: both numbers must be higher than the row above`;
  }
  return null;
}

/** A sensible next row: a little above the last one. */
export function nextRow(rows) {
  const last = stepsOf(rows).at(-1);
  if (!last) return { at: '1000', keep: '750' };
  const gap = last.at - last.keep;
  return { at: String(last.at + gap * 2), keep: String(last.keep + gap * 2) };
}

/** One line per row for the preview under the form. */
export function ladderLines(steps) {
  return steps.map((s) => ({ at: s.at, keep: s.keep, gap: s.at - s.keep, text: `At +${rs(s.at)} the stop keeps ${rs(s.keep)}; every rupee more profit lifts it a rupee, ${rs(s.at - s.keep)} behind the best.` }));
}

/** The lock in a few words, for summaries. */
export function ladderSummary(steps) {
  if (!steps?.length) return 'no lock';
  if (steps.length === 1) return `lock from +${rs(steps[0].at)}, ${rs(steps[0].at - steps[0].keep)} behind`;
  return `lock ladder ${steps.length} rows: +${rs(steps[0].at)} keeps ${rs(steps[0].keep)} … +${rs(steps.at(-1).at)} keeps ${rs(steps.at(-1).keep)}`;
}

export const DEFAULT_EXIT_MIN = 15 * 60 + 15;
export const FIRST_EXIT_MIN = 9 * 60 + 30;

/** Minutes after midnight as "14:15", the value of a time input. */
export const timeText = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** "14:15" as minutes after midnight, or null when it is blank or outside 09:30 to 15:15. */
export function minOfTime(text) {
  const m = /^(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= FIRST_EXIT_MIN && min <= DEFAULT_EXIT_MIN ? min : null;
}
