import mongoose from 'mongoose';

// Per-user switches for the paper options trader. Off until the user turns it on.
const optionSettingsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    enabled: { type: Boolean, default: false },
    minScore: { type: Number, default: 70, min: 60, max: 100 },
    maxLots: { type: Number, default: 2, min: 1, max: 20 }, // most lots in one trade
    maxOpen: { type: Number, default: 1, min: 1, max: 3 },
    maxTrades: { type: Number, default: 3, min: 1, max: 10 }, // entries per day: options punish overtrading
    budget: { type: Number, default: 30000, min: 5000 }, // money set aside for options; premiums in open trades never exceed it
    maxLossPct: { type: Number, default: 7, min: 1, max: 20 }, // % of the budget one trade may lose if its stop is hit
    dailyLossPct: { type: Number, default: 10, min: 2, max: 30 }, // stop opening trades after losing this % of the budget today
    trailPct: { type: Number, default: 25, min: 0, max: 60 }, // stop follows the best premium at this % distance; 0 = off
    lockAtPct: { type: Number, default: 25, min: 5, max: 200 }, // once the premium is up this %, the profit lock starts...
    lockKeepPct: { type: Number, default: 5, min: 0, max: 100 }, // ...and keeps this % of the entry premium
  },
  { timestamps: true },
);

export const OptionSettings = mongoose.model('OptionSettings', optionSettingsSchema);
