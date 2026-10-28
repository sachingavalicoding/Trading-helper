import mongoose from 'mongoose';
import { comboSchema } from '../combos/schema.js';

// Per-user switches for the paper auto-trader. Off until the user turns it on.
const autoSettingsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    enabled: { type: Boolean, default: false },
    minScore: { type: Number, default: 70, min: 60, max: 100 },
    maxOpen: { type: Number, default: 2, min: 1, max: 10 },
    riskPct: { type: Number, default: 0.5, min: 0.1, max: 3 }, // % of capital lost if a stop is hit (used only when riskAmount is 0)
    dailyLossPct: { type: Number, default: 2, min: 0.5, max: 10 }, // stop opening trades after losing this much today
    maxShares: { type: Number, default: 0, min: 0 }, // most shares per auto trade; 0 = no cap, size from risk % and max amount
    earlyNews: { type: Boolean, default: true }, // also take "News gap" ideas, which can start at 09:20 instead of 09:30
    skipSetups: { type: [String], default: [] }, // setups the auto trader leaves alone (Account tab); the scanner still shows them
    maxTradeAmount: { type: Number, default: 30000, min: 1000 }, // most money put into one trade
    combos: { type: [comboSchema], default: [] }, // the user's own entry combinations (Account > Entries); see combos/combos.js
  },
  { timestamps: true },
);

export const AutoSettings = mongoose.model('AutoSettings', autoSettingsSchema);
