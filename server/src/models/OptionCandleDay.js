import mongoose from 'mongoose';

// One trading day of 1-minute candles of one index option contract (the real premiums), packed (see market/optionHistory.js). Market data, shared by every user.
const optionCandleDaySchema = new mongoose.Schema(
  {
    index: { type: String, required: true }, // 'NIFTY' | 'SENSEX'
    symbol: { type: String, required: true }, // the app's option name (options/symbols.js)
    day: { type: String, required: true }, // YYYY-MM-DD, IST
    expiry: { type: String, required: true },
    strike: { type: Number, required: true },
    type: { type: String, enum: ['CE', 'PE'], required: true },
    lotSize: { type: Number, default: 0 },
    count: { type: Number, required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: true },
);
optionCandleDaySchema.index({ symbol: 1, day: 1 }, { unique: true });
optionCandleDaySchema.index({ day: 1, index: 1 });

// Which index-days have been collected in full, so a finished day is not fetched again.
const optionHistoryDaySchema = new mongoose.Schema(
  {
    index: { type: String, required: true },
    day: { type: String, required: true },
    contracts: { type: Number, default: 0 },
    spot: { type: [Number], default: [] }, // [day low, day high] of the index, which chose the strikes
    backfilled: { type: Boolean, default: false }, // read afterwards from the contracts still listed, so the expired ones of that day are missing
  },
  { timestamps: true },
);
optionHistoryDaySchema.index({ index: 1, day: 1 }, { unique: true });

export const OptionCandleDay = mongoose.model('OptionCandleDay', optionCandleDaySchema);
export const OptionHistoryDay = mongoose.model('OptionHistoryDay', optionHistoryDaySchema);
