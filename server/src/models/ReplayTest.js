import mongoose from 'mongoose';

// Replay test (dayreplay/ladder.js), one per user: the last step-up test of settings on past days, run by replay with its own copy of the
// settings. Kept so the result survives a page reload or a restart.
const replayTestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    state: { type: String, enum: ['running', 'done', 'stopped', 'failed'], default: 'running' },
    days: { type: [String], default: [] }, // oldest first
    hidden: { type: [String], default: [] }, // the newest days: a change is kept only if it also does better on these
    fill: { type: mongoose.Schema.Types.Mixed, default: null }, // { slippagePct, fillDelaySec }
    steps: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{ key, kind, name, changes, verdict, why, results, summary }]
    at: { type: mongoose.Schema.Types.Mixed, default: null }, // what runs now: { step, day }
    base: { type: String, default: '' }, // fingerprint of the live settings when the test started
    error: { type: String, default: '' },
    startedAt: Date,
    finishedAt: Date,
    applied: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

export const ReplayTest = mongoose.model('ReplayTest', replayTestSchema);
