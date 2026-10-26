import mongoose from 'mongoose';

const chargesSchema = new mongoose.Schema(
  {
    brokerage: Number,
    stt: Number,
    exchange: Number,
    sebi: Number,
    stamp: Number,
    gst: Number,
    total: Number,
  },
  { _id: false },
);

// Trade book: one row per execution.
const tradeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    position: { type: mongoose.Schema.Types.ObjectId, ref: 'Position' },
    symbol: { type: String, required: true },
    segment: { type: String, enum: ['EQ', 'OPT'], default: 'EQ' },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    role: { type: String },
    qty: { type: Number, required: true },
    price: { type: Number, required: true },
    value: { type: Number, required: true },
    charges: { type: chargesSchema, required: true },
    realizedPnl: { type: Number, default: 0 }, // gross P&L booked by this execution (0 when opening)
    executedAt: { type: Date, default: Date.now },
    tradingDay: { type: String, required: true },
  },
  { timestamps: false },
);

tradeSchema.index({ user: 1, executedAt: -1 });

export const Trade = mongoose.model('Trade', tradeSchema);
