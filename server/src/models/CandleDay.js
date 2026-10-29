import mongoose from 'mongoose';

// One trading day of 1-minute candles for one symbol, packed (see market/historyStore.js). Market data, shared by every user.
const candleDaySchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true },
    day: { type: String, required: true }, // YYYY-MM-DD, IST
    count: { type: Number, required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: true },
);
candleDaySchema.index({ symbol: 1, day: 1 }, { unique: true });
candleDaySchema.index({ day: 1 });

// The calendar range of days a symbol has been fetched for (holidays and weekends included, they simply have no candles).
const candleCoverageSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, unique: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    partial: { type: String, default: null }, // the day (always `to`) saved only up to the time of the last download, not yet the whole session
  },
  { timestamps: true },
);

export const CandleDay = mongoose.model('CandleDay', candleDaySchema);
export const CandleCoverage = mongoose.model('CandleCoverage', candleCoverageSchema);
