import mongoose from 'mongoose';

// A saved combination (see combos.js): the condition keys picked in Account > Entries, how many must hold, and how long an event counts.
export const comboSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, maxlength: 60 },
    conds: { type: [String], default: [] },
    also: { type: [String], default: undefined }, // extra checks that must all hold on top of the rule (an add-on to an "any N of M" combination)
    need: { type: Number, default: 1, min: 1 },
    window: { type: Number, default: 3, min: 1, max: 6 },
    on: { type: Boolean, default: true },
    side: { type: String, enum: ['CE', 'PE'], default: undefined }, // calls only or puts only; unset = both. Missing here before 4 Nov 2026, so the lock was dropped on save
    benchedOn: { type: String, default: undefined }, // 'YYYY-MM-DD': switched off by itself after losses in a row (OptionSettings.benchAfter)
    stopMode: { type: String, enum: ['chart', 'cap', 'atr', 'fixed'], default: undefined }, // its own stop; unset = the shared stop of Account > Entries
    stopAtr: { type: Number, min: 0.8, max: 2.5, default: undefined },
    stopPoints: { type: Number, min: 10, max: 150, default: undefined },
    order: { type: mongoose.Schema.Types.Mixed, default: undefined }, // a share combination's own risk, money per trade, stop %, target and exit time (see normalizeOrder)
    exits: { type: mongoose.Schema.Types.Mixed, default: undefined }, // its own profit ladder, trail and break-even (see normalizeExits); a part left out uses the shared setting
  },
  { _id: false },
);
