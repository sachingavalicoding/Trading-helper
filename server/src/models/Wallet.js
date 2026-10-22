import mongoose from 'mongoose';

// `balance` is the cash ledger: starting capital + realised P&L - charges.
// Margin in use is derived from open positions and pending orders, not stored here.
const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    balance: { type: Number, required: true },
    startingBalance: { type: Number, required: true },
    resetCount: { type: Number, default: 0 },
    lastResetAt: { type: Date },
  },
  { timestamps: true },
);

export const Wallet = mongoose.model('Wallet', walletSchema);
