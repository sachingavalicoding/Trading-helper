import mongoose from 'mongoose';
import { comboSchema } from '../combos/schema.js';

// Per-user switches for the paper auto-trader. Off until the user turns it on.
const autoSettingsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    enabled: { type: Boolean, default: false },
    minScore: { type: Number, default: 70, min: 60, max: 100 },
    maxOpen: { type: Number, default: 2, min: 1, max: 100 },
    maxTrades: { type: Number, default: 0, min: 0, max: 10000 }, // new auto trades a day, your own number; 0 = no limit
    entryFrom: { type: Number, default: 555, min: 555, max: 914 }, // minutes after midnight IST: no new auto trade before it (555 = 09:15; the scanner's own setups still start at 09:20/09:30)
    entryTo: { type: Number, default: 915, min: 556, max: 915 }, // ...and none from it on (915 = 15:15, the square-off)
    riskPct: { type: Number, default: 0.5, min: 0.1, max: 3 }, // % of capital lost if a stop is hit (used only when riskAmount is 0)
    dailyLossPct: { type: Number, default: 2, min: 0.5, max: 100 }, // stop opening trades after losing this much today
    maxShares: { type: Number, default: 0, min: 0 }, // most shares per auto trade; 0 = no cap, size from risk % and max amount
    earlyNews: { type: Boolean, default: true }, // also take "News gap" ideas, which can start at 09:20 instead of 09:30
    trendScore: { type: Boolean, default: false }, // also buy "Trend score" ideas (the score-led entry, scanner/setups.js); off until switched on
    skipSetups: { type: [String], default: [] }, // setups the auto trader leaves alone (Account tab); the scanner still shows them
    maxTradeAmount: { type: Number, default: 30000, min: 1000 }, // most money put into one trade
    // Extra entry rules (scanner/entryRules.js), added 11 Nov 2026. Defaults keep the trader as it was: only the old 0.5% smallest stop and 0.5R no-chase.
    shareRules: {
      marketAgree: { type: Boolean, default: false },
      minVsNifty: { type: Number, default: 0, min: 0, max: 5 },
      minRelVol: { type: Number, default: 0, min: 0, max: 10 },
      confirmBar: { type: Boolean, default: false },
      noChaseR: { type: Number, default: 0.5, min: 0.1, max: 2 },
      minStopPct: { type: Number, default: 0.5, min: 0, max: 2 },
      stopAfterLosses: { type: Number, default: 0, min: 0, max: 20 },
      target: { type: Number, default: 0, min: 0, max: 100000 },
      lockFromR: { type: Number, default: 0, min: 0, max: 2 },
    },
    combos: { type: [comboSchema], default: [] }, // the user's own entry combinations (Account > Entries); see combos/combos.js
  },
  { timestamps: true },
);

export const AutoSettings = mongoose.model('AutoSettings', autoSettingsSchema);
