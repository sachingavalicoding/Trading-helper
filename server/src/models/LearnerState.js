import mongoose from 'mongoose';

// The auto-learner (learner/service.js), one per user and kind ('options' or 'shares'): whether it may change the paper settings by itself,
// its last result, and a log of what it found and changed. The combination it uses lives in the normal saved list under id `learner-pick`.
const learnerStateSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['options', 'shares'], required: true },
    auto: { type: Boolean, default: false }, // use what it finds by itself (paper only); off = it only suggests
    last: { type: mongoose.Schema.Types.Mixed, default: null }, // the last run: { at, day, verdict, text, pick, baseline, candidates, period, pricing, error }
    log: { type: [mongoose.Schema.Types.Mixed], default: [] }, // newest first: { at, action, name, conds, side, text, test, baselineTest }
  },
  { timestamps: true },
);
learnerStateSchema.index({ user: 1, kind: 1 }, { unique: true });

export const LearnerState = mongoose.model('LearnerState', learnerStateSchema);
