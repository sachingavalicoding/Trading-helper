import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { AutoSettings } from '../models/AutoSettings.js';
import { OptionSettings } from '../models/OptionSettings.js';
import { TradeDefaults } from '../models/TradeDefaults.js';
import { CandleDay, CandleCoverage } from '../models/CandleDay.js';
import { OptionCandleDay, OptionHistoryDay } from '../models/OptionCandleDay.js';
import { TickChunk } from '../models/TickChunk.js';
import { addDays } from '../market/days.js';
import { UNDERLYING } from '../options/symbols.js';

// A replay runs against its own copy of the database, so its paper trades can never touch the real paper history.
// The copy holds: the logins and settings (so you trade with your own rules), the saved market data of the days BEFORE the replay day,
// and the recorded seconds and candles OF the replay day, kept apart (the replay feed hands them out only as the virtual clock reaches them).
// Everything else (orders, positions, trades, wallet, logs) starts empty. Clear a replay by starting another one: the copy is dropped first.

export const REPLAY_SUFFIX = '_replay';
export const TEST_SUFFIX = '_test_replay'; // test runs (dayreplay/ladder.js) get their own database, so a day you are replaying by hand is left alone
export const DAY_CANDLES = 'replayday_candles'; // CandleDay documents of the replay day
export const DAY_OPTION_CANDLES = 'replayday_option_candles'; // OptionCandleDay documents of the replay day

export const DEFAULT_DB = 'test'; // the database MongoDB uses when the address names none (an Atlas address often ends in /?retryWrites=...)

/** The parts of a Mongo address: server, database name (DEFAULT_DB when none is given) and the ?options. */
function uriParts(uri) {
  const m = /^(mongodb(?:\+srv)?:\/\/[^/?]*)(?:\/([^?]*))?(\?.*)?$/.exec(uri);
  if (!m) throw new Error('MONGO_URI is not a mongodb:// or mongodb+srv:// address');
  return { server: m[1], name: m[2] || DEFAULT_DB, query: m[3] || '' };
}

const dbNameOf = (uri) => uriParts(uri).name;
const withDb = (uri, name) => {
  const p = uriParts(uri);
  return `${p.server}/${name}${p.query}`;
};

/** The replay database's address: the same server, the database name with `_replay` added (`test_replay` when the address names none). */
export function replayUriFor(uri) {
  const name = dbNameOf(uri);
  return name.endsWith(REPLAY_SUFFIX) ? uri : withDb(uri, `${name}${REPLAY_SUFFIX}`);
}

/**
 * The test runs' database: the same server, the database name with `_test_replay` added (it still ends in `_replay`). Days that run side
 * by side each get their own: slot 1 is `_test1_replay`, slot 2 `_test2_replay`, and so on.
 */
export function testUriFor(uri, slot = 0) {
  const name = dbNameOf(uri);
  if (name.endsWith(REPLAY_SUFFIX)) throw new Error('A test run must start from the live database');
  return withDb(uri, `${name}${slot ? `_test${slot}${REPLAY_SUFFIX}` : TEST_SUFFIX}`);
}

const COPY_ALL = [User, AutoSettings, OptionSettings, TradeDefaults];

async function copy(from, to, name, filter = {}) {
  const docs = await from.collection(name).find(filter).toArray();
  for (let i = 0; i < docs.length; i += 500) await to.collection(name).insertMany(docs.slice(i, i + 500), { ordered: false });
  return docs.length;
}

/**
 * Drops the replay database and fills it for `day`. Refuses to touch any database whose name does not end in `_replay`.
 * @param {object} o
 * @param {boolean} [o.seconds]    copy the day's recorded seconds too (only needed when the replay plays them)
 * @param {number} [o.priorDays]   copy only this many calendar days of earlier market data (a test run needs a few weeks, not three months)
 * @param {Record<string, any[]>} [o.settings] the settings documents to use instead of the live ones (a test run's own copy)
 */
export async function seedReplayDb({ sourceUri, targetUri, day, seconds = true, priorDays = 0, settings = null }) {
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
    for (const M of COPY_ALL) {
      const name = M.collection.name;
      if (settings?.[name]) {
        if (settings[name].length) await d.collection(name).insertMany(settings[name]);
        out[name] = settings[name].length;
      } else out[name] = await copy(s, d, name);
    }
    // market data of earlier days: what indicators and studies look back on
    const before = priorDays > 0 ? { $lt: day, $gte: addDays(day, -priorDays) } : { $lt: day };
    out.candles = await copy(s, d, CandleDay.collection.name, { day: before });
    out.optionCandles = await copy(s, d, OptionCandleDay.collection.name, { day: before });
    out.optionDays = await copy(s, d, OptionHistoryDay.collection.name, { day: before });
    // coverage stops the day before, so a study never reads the replay day whole
    const cov = await s.collection(CandleCoverage.collection.name).find({}).toArray();
    const lastDay = addDays(day, -1);
    const kept = cov.filter((c) => c.from <= lastDay).map((c) => ({ ...c, to: c.to > lastDay ? lastDay : c.to, partial: null }));
    if (kept.length) await d.collection(CandleCoverage.collection.name).insertMany(kept);
    // the replay day itself, kept apart
    out.ticks = seconds ? await copy(s, d, TickChunk.collection.name, { day }) : 0;
    out.dayCandles = await copy(s, d, CandleDay.collection.name, { day });
    out.niftyMinutes = (await d.collection(CandleDay.collection.name).findOne({ day, symbol: UNDERLYING }, { projection: { count: 1 } }))?.count ?? 0;
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
