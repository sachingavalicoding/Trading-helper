import mongoose from 'mongoose';

// A short-lived claim that one app server is placing a new automatic option buy for a user right now. The key is unique, so when two
// copies of the server share one database (a laptop and a phone, say) only one of them can buy at a time; the other sees the claim
// and skips. A claim holds for a minute at most, so a server that died half-way never blocks buying for long.
const entryClaimSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    owner: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { timestamps: false },
);
entryClaimSchema.index({ until: 1 }, { expireAfterSeconds: 3600 }); // Mongo tidies old rows; the `until` check is what counts

export const EntryClaim = mongoose.model('EntryClaim', entryClaimSchema);
