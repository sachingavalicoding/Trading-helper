import mongoose from 'mongoose';
import { comboSchema } from '../combos/schema.js';
import { INDEX_KEYS } from '../options/symbols.js';
import { MOVED_KEYS } from '../options/moved.js';

// Per-user switches for the paper options trader. Off until the user turns it on.
const optionSettingsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    enabled: { type: Boolean, default: false },
    minScore: { type: Number, default: 70, min: 60, max: 100 },
    maxLots: { type: Number, default: 2, min: 1, max: 20 }, // most lots in one trade
    maxOpen: { type: Number, default: 1, min: 1, max: 3 },
    maxTrades: { type: Number, default: 3, min: 1, max: 10 }, // entries per day: options punish overtrading
    budget: { type: Number, default: 60000, min: 5000 }, // money set aside for options, shared by Nifty and Sensex; premiums in open trades never exceed it
    indexes: { type: [{ type: String, enum: INDEX_KEYS }], default: () => ['NIFTY'] }, // the indexes the bot watches and buys on; nothing saved means Nifty only
    mirror: { type: Boolean, default: false }, // false: one call and one put at a time across both indexes; true: each index may hold its own
    patternEntries: { type: Boolean, default: true }, // buy when one of the chosen chart patterns shows (see study/patterns.js)
    patterns: { type: [String], default: () => ['breakout', 'insideBar', 'emaCross'] }, // the 30-day study's winners: more than 12 trades and a profit
    patternStopMode: { type: String, enum: ['chart', 'cap', 'atr', 'fixed'], default: 'chart' }, // where an entry puts its stop: the chart level, the chart level pulled in to patternStopAtr, always patternStopAtr from the entry, or always patternStopPoints Nifty points from it
    entryFrom: { type: Number, default: 555, min: 555, max: 914 }, // minutes after midnight IST: no new trade before it (555 = 09:15)
    entryTo: { type: Number, default: 915, min: 556, max: 915 }, // ...and none from it on (915 = 15:15)
    patternStopAtr: { type: Number, default: 2, min: 0.8, max: 2.5 }, // in 5-minute ATRs
    patternStopPoints: { type: Number, default: 30, min: 10, max: 150 }, // Nifty points, for the 'fixed' stop
    trailMode: { type: String, enum: ['off', 'points'], default: 'off' }, // 'points': once the index has moved trailStart points your way, the chart stop follows the best price trailPoints behind it and never moves back
    trailPoints: { type: Number, default: 25, min: 5, max: 200 }, // Nifty points between the best price and the stop
    trailStart: { type: Number, default: 25, min: 0, max: 200 }, // Nifty points in your favour before the trail starts
    breakEvenPoints: { type: Number, default: 0, min: 0, max: 200 }, // 0 = off; otherwise once the index has moved this many points your way the stop moves to the entry price
    chasePct: { type: Number, default: 0, min: 0, max: 200 }, // 0 = off; otherwise no buy while the premium is more than this % above its low of the last chaseMinutes (the anti-chase check, options/chase.js)
    chaseMinutes: { type: Number, default: 15, min: 5, max: 60 },
    movedCheck: { type: String, enum: ['off', ...MOVED_KEYS], default: 'off' }, // the "already moved" check on the index (options/moved.js): which measure...
    movedLimit: { type: Number, default: 0, min: 0, max: 100 }, // ...and the most it may show in the trade's direction (0 = off)
    withDay: { type: Boolean, default: false }, // the "with the day" check (options/dayBias.js): calls only above today's open and average, puts only below both
    comboStreak: { type: Number, default: 0, min: 0, max: 5 }, // 0 = off; otherwise an entry (pattern or combination) that lost this many times in a row today rests until tomorrow
    probation: { type: Boolean, default: true }, // a combination with fewer than PROBATION_TRADES closed live trades is bought with 1 lot only
    pausedOn: { type: String, default: null }, // 'YYYY-MM-DD' (IST): no new automatic buy on that day; open trades are still managed
    comboMinScore: { type: Number, default: 0, min: 0, max: 95 }, // 0 = off; otherwise a combination is bought only while the chart score of its side is at least this
    patternMinScore: { type: Number, default: 0, min: 0, max: 95 }, // 0 = off; otherwise a pattern is bought only while the chart score of its side is at least this (the study's "Patterns, score 70+")
    scoreEntries: { type: Boolean, default: false }, // no longer used: the all-checks score does not buy any more (patterns and combinations do)
    lossStreak: { type: Number, default: 2, min: 0, max: 5 }, // 0 = off; otherwise no new automatic buy today after this many losing option trades in a row today (any entry)
    benchAfter: { type: Number, default: 3, min: 0, max: 10 }, // 0 = off; otherwise a combination is switched off by itself after this many live losing trades in a row (it stays saved, marked benchedOn)
    dailyLossPct: { type: Number, default: 10, min: 2, max: 30 }, // stop opening trades after losing this % of the budget today
    entryClock: { type: String, enum: ['5m', '1m', '1s'], default: '5m' }, // when a combination may buy: the 5-minute candle closed, each minute, or the second it turns true on the forming candle
    exitClock: { type: String, enum: ['5m', '1m', '1s'], default: '1m' }, // when the chart stop may sell: a 5-minute close beyond it, a 1-minute close beyond it, or the second the index touches it
    secondConfirm: { type: Number, default: 3, min: 0, max: 15 }, // seconds a 1-second entry must stay true before it buys
    comboEntries: { type: Boolean, default: true }, // buy when one of the user's own combinations (below) turns true
    combos: { type: [comboSchema], default: [] }, // the user's own entry combinations (Account > Entries); see combos/combos.js
  },
  { timestamps: true },
);

export const OptionSettings = mongoose.model('OptionSettings', optionSettingsSchema);
