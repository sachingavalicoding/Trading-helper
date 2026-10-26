import mongoose from 'mongoose';

// Per-user profit lock applied to every new position (manual or auto). Editable per position later.
const tradeDefaultsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    lockEnabled: { type: Boolean, default: true },
    lockTrigger: { type: Number, default: 1000, min: 1 }, // profit in rupees at which the stop starts protecting
    lockAmount: { type: Number, default: 400, min: 1 }, // profit in rupees the stop then locks in
  },
  { timestamps: true },
);

export const TRADE_DEFAULTS = { lockEnabled: true, lockTrigger: 1000, lockAmount: 400 };
export const TradeDefaults = mongoose.model('TradeDefaults', tradeDefaultsSchema);
