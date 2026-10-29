import mongoose from 'mongoose';

// One row per decision the auto-trader made about a scanner idea, placed or skipped, with the
// plan and the score breakdown as they were at that moment. A placed row is later filled in with
// how the trade ended, so a day can be reviewed: was it the rules, the entry, or just the market?
const outcomeSchema = new mongoose.Schema(
  {
    exitReason: { type: String, enum: ['STOP', 'LOCK', 'TARGET', 'MANUAL', 'SQUARE_OFF', 'TIME', 'TRAIL'] },
    exitPrice: Number,
    grossPnl: Number,
    charges: Number,
    netPnl: Number, // after charges
    resultR: Number, // price move in units of the planned risk
    minutesHeld: Number,
    bestR: Number, // furthest the price went in our favour while held
    worstR: Number, // furthest it went against us
    closedAt: Date,
  },
  { _id: false },
);

const autoLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }, // IST date
    idea: { type: mongoose.Schema.Types.ObjectId, ref: 'ScanIdea' },
    symbol: { type: String, required: true },
    segment: { type: String, enum: ['EQ', 'OPT'], default: 'EQ' },
    detail: { type: mongoose.Schema.Types.Mixed }, // options: the read of the chart behind the trade (direction, stop on the Nifty chart, premium plan)
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    setup: String,
    score: Number,
    decision: { type: String, enum: ['PLACED', 'SKIPPED'], required: true },
    reason: String, // why it was skipped
    status: { type: String, enum: ['SKIPPED', 'OPEN', 'CLOSED'], required: true },
    entry: Number, // the idea's planned entry, stop and targets
    stopLoss: Number,
    target1: Number,
    target2: Number,
    riskReward: Number,
    ltp: Number, // price when the decision was made
    movedR: Number, // how far price had run from the planned entry, in risk units
    qty: Number,
    fillPrice: Number,
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    position: { type: mongoose.Schema.Types.ObjectId, ref: 'Position' },
    card: { type: mongoose.Schema.Types.Mixed }, // the scanner card: checks, score breakdown, reasons
    outcome: outcomeSchema,
    decidedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

autoLogSchema.index({ user: 1, day: 1, decidedAt: 1 });
autoLogSchema.index({ user: 1, symbol: 1, status: 1 });

export const AutoLog = mongoose.model('AutoLog', autoLogSchema);
