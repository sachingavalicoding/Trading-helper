import mongoose from 'mongoose';

// Small bookkeeping for the monthly option-data email: who gets it, and which files were already sent. The data itself is in files, not here.
const archiveStateSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'options', unique: true },
    recipient: { type: String, default: '' },
    sent: { type: [{ month: String, part: Number, to: String, at: Date, _id: false }], default: [] },
  },
  { timestamps: true },
);

export const ArchiveState = mongoose.model('ArchiveState', archiveStateSchema);
