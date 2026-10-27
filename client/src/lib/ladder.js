// Helpers for the lock-ladder editor. Rows are { at, keep } as text while typing; the server wants numbers.

/** Turn typed rows into numbers, or say what is wrong with them (the server checks the same rules). */
export function readLadder(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const at = Number(rows[i].at);
    const keep = Number(rows[i].keep);
    if (!(at > 0) || !(keep > 0)) return { error: `Rung ${i + 1}: fill in both numbers` };
    if (!(at > keep)) return { error: `Rung ${i + 1}: the profit that starts the lock must be larger than the profit it keeps` };
    if (i > 0 && !(at > out[i - 1].at && keep > out[i - 1].keep)) return { error: `Rung ${i + 1}: both numbers must be larger than the rung above` };
    out.push({ at, keep });
  }
  if (!out.length) return { error: 'Add at least one rung, or use the built-in ladder' };
  return { rows: out };
}

/** The next rung to offer when you tap "Add rung": about half as far again as the last one. */
export function nextRung(rows, step) {
  const last = rows[rows.length - 1];
  if (!last) return { at: '', keep: '' };
  const round = (v) => Math.round(v / step) * step;
  const at = round(Number(last.at) * 1.5) || Number(last.at) + step;
  const keep = round(Number(last.keep) * 1.5) || Number(last.keep) + step;
  return { at: String(Math.max(at, Number(last.at) + step)), keep: String(Math.max(keep, Number(last.keep) + step)) };
}

export const sameLadder = (a, b) => a.length === b.length && a.every((r, i) => Number(r.at) === Number(b[i].at) && Number(r.keep) === Number(b[i].keep));
