import mongoose from 'mongoose';

// Per-user switches for the paper auto-trader. Off until the user turns it on.
const autoSettingsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    enabled: { type: Boolean, default: false },
    minScore: { type: Number, default: 70, min: 60, max: 100 },
    maxOpen: { type: Number, default: 2, min: 1, max: 10 },
    riskPct: { type: Number, default: 0.5, min: 0.1, max: 3 }, // % of capital lost if a stop is hit
    dailyLossPct: { type: Number, default: 2, min: 0.5, max: 10 }, // stop opening trades after losing this much today
    maxShares: { type: Number, default: 1, min: 1 }, // shares per auto trade, however much the risk rules would allow
    maxTradeAmount: { type: Number, default: 30000, min: 1000 }, // most money put into one trade
  },
  { timestamps: true },
);

export const AutoSettings = mongoose.model('AutoSettings', autoSettingsSchema);
