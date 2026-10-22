import mongoose from 'mongoose';

// A trade idea the scanner raised when a setup's trigger fired. Market-wide, not per user:
// the plan is frozen when raised and followed until target 1, the stop loss or expiry,
// so the scanner's track record is the same for everyone.
const scanIdeaSchema = new mongoose.Schema(
  {
    day: { type: String, required: true }, // IST date, one idea per stock, setup and side per day
    symbol: { type: String, required: true },
    setup: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    entry: { type: Number, required: true },
    stopLoss: { type: Number, required: true },
    target1: { type: Number, required: true },
    target2: { type: Number, required: true },
    riskReward: { type: Number, required: true },
    score: { type: Number, required: true },
    status: { type: String, enum: ['OPEN', 'TARGET_HIT', 'STOPPED', 'EXPIRED'], default: 'OPEN' },
    exitPrice: Number,
    closedAt: Date,
    card: { type: mongoose.Schema.Types.Mixed }, // everything the screen shows (reasons, checks, notes)
  },
  { timestamps: true },
);

scanIdeaSchema.index({ day: 1, symbol: 1, setup: 1, side: 1 }, { unique: true });
scanIdeaSchema.index({ status: 1 });

export const ScanIdea = mongoose.model('ScanIdea', scanIdeaSchema);
