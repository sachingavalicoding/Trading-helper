import mongoose from 'mongoose';

// A saved combination (see combos.js): the condition keys picked in Account > Entries, how many must hold, and how long an event counts.
export const comboSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, maxlength: 60 },
    conds: { type: [String], default: [] },
    need: { type: Number, default: 1, min: 1 },
    window: { type: Number, default: 3, min: 1, max: 6 },
    on: { type: Boolean, default: true },
    index: { type: String, enum: ['NIFTY', 'SENSEX'], default: undefined }, // the one index it trades; unset = both
    stopMode: { type: String, enum: ['chart', 'cap', 'atr', 'fixed'], default: undefined }, // its own stop; unset = the shared stop of Account > Entries
    stopAtr: { type: Number, min: 0.8, max: 2.5, default: undefined },
    stopPoints: { type: Number, min: 10, max: 150, default: undefined },
    exits: { type: mongoose.Schema.Types.Mixed, default: undefined }, // its own profit ladder, trail and break-even (see normalizeExits); a part left out uses the shared setting
  },
  { _id: false },
);
