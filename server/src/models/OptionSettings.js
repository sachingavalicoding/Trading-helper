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
    dailyLossPct: { type: Number, default: 10, min: 2, max: 30 }, // stop opening trades after losing this % of the budget today
  },
  { timestamps: true },
);

export const OptionSettings = mongoose.model('OptionSettings', optionSettingsSchema);
