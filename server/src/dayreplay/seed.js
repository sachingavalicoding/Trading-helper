import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { AutoSettings } from '../models/AutoSettings.js';
import { OptionSettings } from '../models/OptionSettings.js';
import { TradeDefaults } from '../models/TradeDefaults.js';
import { CandleDay, CandleCoverage } from '../models/CandleDay.js';
import { OptionCandleDay, OptionHistoryDay } from '../models/OptionCandleDay.js';
import { TickChunk } from '../models/TickChunk.js';
import { addDays } from '../market/days.js';

// A replay runs against its own copy of the database, so its paper trades can never touch the real paper history.
// The copy holds: the logins and settings (so you trade with your own rules), the saved market data of the days BEFORE the replay day,
// and the recorded seconds and candles OF the replay day, kept apart (the replay feed hands them out only as the virtual clock reaches them).
// Everything else (orders, positions, trades, wallet, logs) starts empty. Clear a replay by starting another one: the copy is dropped first.

export const REPLAY_SUFFIX = '_replay';
export const DAY_CANDLES = 'replayday_candles'; // CandleDay documents of the replay day
export const DAY_OPTION_CANDLES = 'replayday_option_candles'; // OptionCandleDay documents of the replay day

const dbNameOf = (uri) => /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, ''))?.[1] ?? '';

/** The replay database's address: the same server, the database name with `_replay` added. */
export function replayUriFor(uri) {
  const name = dbNameOf(uri);
  if (!name) throw new Error('MONGO_URI must name a database to run a replay');
  return name.endsWith(REPLAY_SUFFIX) ? uri : uri.replace(new RegExp(`/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?|$)`), `/${name}${REPLAY_SUFFIX}$1`);
}

const COPY_ALL = [User, AutoSettings, OptionSettings, TradeDefaults];

async function copy(from, to, name, filter = {}) {
  const docs = await from.collection(name).find(filter).toArray();
  for (let i = 0; i < docs.length; i += 500) await to.collection(name).insertMany(docs.slice(i, i + 500), { ordered: false });
  return docs.length;
}

/** Drops the replay database and fills it for `day`. Refuses to touch any database whose name does not end in `_replay`. */
export async function seedReplayDb({ sourceUri, targetUri, day }) {
  const srcName = dbNameOf(sourceUri);
  const dstName = dbNameOf(targetUri);
  if (!dstName.endsWith(REPLAY_SUFFIX) || srcName === dstName) throw new Error(`Refusing to replay into "${dstName}": the replay database must be a separate one ending in ${REPLAY_SUFFIX}`);
  const src = await mongoose.createConnection(sourceUri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  const dst = await mongoose.createConnection(targetUri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  try {
    await dst.dropDatabase();
    const s = src.db;
    const d = dst.db;
    const out = {};
    for (const M of COPY_ALL) out[M.collection.name] = await copy(s, d, M.collection.name);
    // market data of earlier days: what indicators and studies look back on
    out.candles = await copy(s, d, CandleDay.collection.name, { day: { $lt: day } });
    out.optionCandles = await copy(s, d, OptionCandleDay.collection.name, { day: { $lt: day } });
    out.optionDays = await copy(s, d, OptionHistoryDay.collection.name, { day: { $lt: day } });
    // coverage stops the day before, so a study never reads the replay day whole
    const cov = await s.collection(CandleCoverage.collection.name).find({}).toArray();
    const before = addDays(day, -1);
    const kept = cov.filter((c) => c.from <= before).map((c) => ({ ...c, to: c.to > before ? before : c.to, partial: null }));
    if (kept.length) await d.collection(CandleCoverage.collection.name).insertMany(kept);
    // the replay day itself, kept apart
    out.ticks = await copy(s, d, TickChunk.collection.name, { day });
    out.dayCandles = await copy(s, d, CandleDay.collection.name, { day });
    if (out.dayCandles) {
      const docs = await d.collection(CandleDay.collection.name).find({ day }).toArray();
      await d.collection(DAY_CANDLES).insertMany(docs);
      await d.collection(CandleDay.collection.name).deleteMany({ day });
    }
    const optDocs = await s.collection(OptionCandleDay.collection.name).find({ day }).toArray();
    if (optDocs.length) await d.collection(DAY_OPTION_CANDLES).insertMany(optDocs);
    out.dayOptionCandles = optDocs.length;
    return out;
  } finally {
    await Promise.allSettled([src.close(), dst.close()]);
  }
}
