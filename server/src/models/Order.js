import mongoose from 'mongoose';
import { isOptionSymbol } from '../options/symbols.js';

export const ORDER_TYPES = ['MARKET', 'LIMIT', 'SL_M'];
export const ORDER_STATUS = ['OPEN', 'FILLED', 'CANCELLED', 'REJECTED'];
// ENTRY: placed by the user. STOPLOSS/TARGET: exit legs created when an entry with SL/target fills.
// EXIT: one-tap exit of a position. SQUAREOFF: the 15:15 IST auto square-off or "exit all".
export const ORDER_ROLES = ['ENTRY', 'EXIT', 'STOPLOSS', 'TARGET', 'SQUAREOFF'];

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    orderType: { type: String, enum: ORDER_TYPES, required: true },
    product: { type: String, enum: ['MIS'], default: 'MIS' },
    segment: { type: String, enum: ['EQ', 'OPT'], default: 'EQ', index: true }, // shares or Nifty index options; kept apart on every screen
    role: { type: String, enum: ORDER_ROLES, default: 'ENTRY' },
    source: { type: String, enum: ['MANUAL', 'AUTO'], default: 'MANUAL' }, // AUTO = placed by the paper auto-trader
    qty: { type: Number, required: true, min: 1 },
    price: { type: Number }, // limit price
    triggerPrice: { type: Number }, // SL-M trigger
    stopLoss: { type: Number }, // requested on entry orders
    target: { type: Number },
    status: { type: String, enum: ORDER_STATUS, default: 'OPEN', index: true },
    filledQty: { type: Number, default: 0 },
    avgFillPrice: { type: Number },
    filledAt: { type: Date },
    cancelledAt: { type: Date },
    rejectReason: { type: String },
    blockedMargin: { type: Number, default: 0 },
    parentOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    ocoGroup: { type: String, index: true },
    ltpAtPlacement: { type: Number },
    tradingDay: { type: String, required: true },
  },
  { timestamps: true },
);

orderSchema.index({ user: 1, createdAt: -1 });

// Every order, from any code path, lands in the right segment by its symbol.
orderSchema.pre('validate', function setSegment() {
  this.segment = isOptionSymbol(this.symbol) ? 'OPT' : 'EQ';
});

export const Order = mongoose.model('Order', orderSchema);
