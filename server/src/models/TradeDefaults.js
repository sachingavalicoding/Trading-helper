import mongoose from 'mongoose';

// Per-user stop and profit lock for every new position, auto or by hand, set apart for shares and for options.
// The stop is the rupees one trade may lose; the lock starts once the profit reaches `lockStart`, keeps `lockStart - lockGap`,
// and from then on follows `lockGap` behind the best profit, so +₹1,000 keeps ₹900, +₹1,100 keeps ₹1,000 and so on.
const rules = (stopLoss, lockStart, lockGap) => ({
  stopLoss: { type: Number, default: stopLoss, min: 0 }, // rupees lost if the stop is hit; 0 = no automatic stop
  lockStart: { type: Number, default: lockStart, min: 0 }, // profit in rupees at which the lock starts; 0 = no profit lock
  lockGap: { type: Number, default: lockGap, min: 1 }, // rupees the stop stays behind the best profit
});

const tradeDefaultsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    shares: rules(200, 250, 80),
    options: rules(500, 1000, 250),
  },
  { timestamps: true },
);

export const TRADE_DEFAULTS = { shares: { stopLoss: 200, lockStart: 250, lockGap: 80 }, options: { stopLoss: 500, lockStart: 1000, lockGap: 250 } };
export const TradeDefaults = mongoose.model('TradeDefaults', tradeDefaultsSchema);

/** The stop and lock rules for one segment ('EQ' or 'OPT'), with anything unset falling back to the built-in values. */
export function rulesFor(doc, segment) {
  const key = segment === 'OPT' ? 'options' : 'shares';
  const base = TRADE_DEFAULTS[key];
  const d = doc?.[key] ?? {};
  return { stopLoss: d.stopLoss ?? base.stopLoss, lockStart: d.lockStart ?? base.lockStart, lockGap: d.lockGap ?? base.lockGap };
}

/** The same rules for the segment of a user, read from the database. */
export async function loadRules(userId, segment) {
  return rulesFor(await TradeDefaults.findOne({ user: userId }).lean(), segment);
}
