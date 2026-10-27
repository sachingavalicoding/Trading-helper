import mongoose from 'mongoose';
import { isOptionSymbol } from '../options/symbols.js';

// One document per round trip: opened when flat -> non-zero, closed when it returns to flat.
// netQty is signed (+ long, - short).
const positionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String, required: true },
    product: { type: String, enum: ['MIS'], default: 'MIS' },
    segment: { type: String, enum: ['EQ', 'OPT'], default: 'EQ', index: true }, // shares or Nifty index options; kept apart on every screen
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
    direction: { type: String, enum: ['LONG', 'SHORT'], required: true },
    netQty: { type: Number, required: true },
    avgPrice: { type: Number, required: true },
    buyQty: { type: Number, default: 0 },
    sellQty: { type: Number, default: 0 },
    buyValue: { type: Number, default: 0 },
    sellValue: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 }, // gross, before charges
    charges: { type: Number, default: 0 },
    margin: { type: Number, default: 0 },
    lockTrigger: { type: Number, default: null }, // once profit reaches this many rupees, the stop locks in lockAmount
    lockAmount: { type: Number, default: null },
    lockSteps: { type: [{ _id: false, at: Number, keep: Number }], default: [] }, // profit ladder in rupees: once profit reaches `at` the stop keeps `keep`, then trails (at - keep) behind the best profit until the next rung
    stepPrices: { type: [Number], default: [] }, // targets to run through: past each one the stop jumps to just short of it
    lockRatio: { type: Number, default: null }, // past lockTrigger, the lock grows by this share of every extra rupee of profit (null = trail lockTrigger - lockAmount behind)
    trailPct: { type: Number, default: null }, // stop loss follows the price at this % distance, only towards profit
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
    tradingDay: { type: String, required: true },
  },
  { timestamps: true },
);

positionSchema.pre('validate', function setSegment() {
  this.segment = isOptionSymbol(this.symbol) ? 'OPT' : 'EQ';
});

positionSchema.index({ user: 1, symbol: 1 }, { unique: true, partialFilterExpression: { status: 'OPEN' } });
positionSchema.index({ user: 1, status: 1, closedAt: -1 });

positionSchema.virtual('netPnl').get(function netPnl() {
  return Math.round((this.realizedPnl - this.charges) * 100) / 100;
});
positionSchema.set('toJSON', { virtuals: true });

export const Position = mongoose.model('Position', positionSchema);
