import mongoose from 'mongoose';

// The latest options study a user ran, so the screen still has it after a restart. One per user and kind.
const studyRunSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, default: 'options' },
    simulated: { type: Boolean, default: false }, // made on the mock feed, whose history is random
    result: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);
studyRunSchema.index({ user: 1, kind: 1 }, { unique: true });

export const StudyRun = mongoose.model('StudyRun', studyRunSchema);
