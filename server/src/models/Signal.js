import mongoose from 'mongoose';

// A BUY/SELL suggestion shown to a user, tracked until it hits its target or stop loss,
// so the dashboard can show how often the signals actually worked.
const signalSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String, required: true },
    action: { type: String, enum: ['BUY', 'SELL'], required: true },
    entry: { type: Number, required: true },
    stopLoss: { type: Number, required: true },
    target: { type: Number, required: true },
    riskReward: { type: Number, required: true },
    score: { type: Number, required: true },
    status: { type: String, enum: ['OPEN', 'TARGET_HIT', 'SL_HIT', 'EXPIRED'], default: 'OPEN' },
    exitPrice: Number,
    closedAt: Date,
  },
  { timestamps: true },
);

signalSchema.index({ status: 1, symbol: 1 });
signalSchema.index({ user: 1, createdAt: -1 });

export const Signal = mongoose.model('Signal', signalSchema);
