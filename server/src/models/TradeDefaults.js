import mongoose from 'mongoose';

// Per-user stop and profit lock for every new position, auto or by hand, set apart for shares and for options.
// The stop is the rupees one trade may lose; the lock starts once the profit reaches `lockStart`, keeps `lockStart - lockGap`,
// and from then on follows `lockGap` behind the best profit, so +₹1,000 keeps ₹900, +₹1,100 keeps ₹1,000 and so on.
// `steps` is the same lock written as rows the user types: once the profit reaches a row's `at` the stop keeps that row's `keep`,
// and above it the stop follows `at - keep` behind the best profit until the next row takes over. With no rows, lockStart and lockGap
// are the single row [{ at: lockStart, keep: lockStart - lockGap }], and lockStart 0 means no profit lock.
const rules = (stopLoss, lockStart, lockGap) => ({
  stopLoss: { type: Number, default: stopLoss, min: 0 }, // rupees lost if the stop is hit (for options: the most one trade may lose at its chart stop); 0 = none
  lockStart: { type: Number, default: lockStart, min: 0 }, // profit in rupees at which the lock starts; 0 = no profit lock
  lockGap: { type: Number, default: lockGap, min: 1 }, // rupees the stop stays behind the best profit
  steps: { type: [{ _id: false, at: Number, keep: Number }], default: [] }, // the typed ladder; empty = use lockStart and lockGap
  lockOn: { type: Boolean, default: true }, // false = no profit lock for new trades; the typed rows are kept so the lock can be switched back on
  exitMin: { type: Number, default: 915, min: 570, max: 915 }, // minutes after midnight IST when the auto trader closes its trades: 915 = 15:15, the square-off
});

const tradeDefaultsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    shares: rules(200, 250, 80),
    options: rules(1500, 1000, 250),
  },
  { timestamps: true },
);

export const DEFAULT_EXIT_MIN = 15 * 60 + 15;
export const MIN_EXIT_MIN = 9 * 60 + 30;

export const TRADE_DEFAULTS = { shares: { stopLoss: 200, lockStart: 250, lockGap: 80 }, options: { stopLoss: 1500, lockStart: 1000, lockGap: 250 } };
export const TradeDefaults = mongoose.model('TradeDefaults', tradeDefaultsSchema);

/** The stop and lock rules for one segment ('EQ' or 'OPT'), with anything unset falling back to the built-in values. */
export function rulesFor(doc, segment, { raw = false } = {}) {
  const key = segment === 'OPT' ? 'options' : 'shares';
  const base = TRADE_DEFAULTS[key];
  const d = doc?.[key] ?? {};
  const out = { stopLoss: d.stopLoss ?? base.stopLoss, lockStart: d.lockStart ?? base.lockStart, lockGap: d.lockGap ?? base.lockGap, exitMin: d.exitMin ?? DEFAULT_EXIT_MIN, lockOn: d.lockOn !== false };
  const typed = (d.steps ?? []).map(({ at, keep }) => ({ at, keep }));
  out.steps = typed.length ? typed : out.lockStart > out.lockGap ? [{ at: out.lockStart, keep: out.lockStart - out.lockGap }] : [];
  if (raw) return out;
  // Switched off: everything that reads the rules sees no profit lock, while `savedSteps` keeps the rows for the screen.
  out.savedSteps = out.steps;
  if (!out.lockOn) Object.assign(out, { steps: [], lockStart: 0 });
  return out;
}

export const MAX_STEPS = 8;

/** Why a typed ladder cannot be used, or null: every row keeps less than it needs, and the rows rise. */
export function ladderProblem(steps) {
  if (steps.length > MAX_STEPS) return `Use at most ${MAX_STEPS} rows`;
  for (const [i, s] of steps.entries()) {
    if (!(s.at > 0) || !(s.keep >= 0)) return `Row ${i + 1}: enter a profit above 0 and a lock of 0 or more`;
    if (!(s.at > s.keep)) return `Row ${i + 1}: the stop can only keep less than the profit that sets it`;
    if (i > 0 && !(s.at > steps[i - 1].at && s.keep > steps[i - 1].keep)) return `Row ${i + 1}: profit and lock must both be higher than the row above`;
  }
  return null;
}

/** The lock in words, for the day report and the screens: "+₹1,000 keeps ₹750, +₹2,000 keeps ₹1,800". */
export function ladderText(steps) {
  const rs = (v) => `₹${Number(v).toLocaleString('en-IN')}`;
  return steps.length ? steps.map((s) => `at +${rs(s.at)} the stop keeps ${rs(s.keep)}`).join(', ') : 'no profit lock';
}

/** The same rules for the segment of a user, read from the database. */
export async function loadRules(userId, segment) {
  return rulesFor(await TradeDefaults.findOne({ user: userId }).lean(), segment);
}
