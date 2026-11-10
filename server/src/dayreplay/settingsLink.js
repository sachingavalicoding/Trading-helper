import mongoose from 'mongoose';
import { OptionSettings } from '../models/OptionSettings.js';
import { AutoSettings } from '../models/AutoSettings.js';
import { TradeDefaults } from '../models/TradeDefaults.js';
import { logger } from '../utils/logger.js';

// A replay uses the SAME settings as the live app, all the time: what you change in the live app (limits, ladder, stop, how fast to buy and
// sell, entries, combinations, switches) reaches the running replay within a few seconds (the other way, a change made on the replay's
// Account page, is passed to the live app by keepSettings.js). Only settings are linked; orders, positions, trades, the wallet and the clock stay
// in the replay, and so does "pause today" (a date, and the replay runs on another day).

export const SETTINGS_COLLECTIONS = [OptionSettings.collection.name, AutoSettings.collection.name, TradeDefaults.collection.name];
const stable = (docs) => JSON.stringify(docs.map((d) => JSON.parse(JSON.stringify(d))).sort((a, b) => String(a._id).localeCompare(String(b._id))));

/**
 * Copies the settings collections from the live database into the replay database, again whenever they change.
 * `read(name)` -> the live docs, `replace(name, docs)` -> makes the replay's collection equal to them. Both are plain functions so a test can stand in.
 */
export class SettingsSync {
  constructor({ read, replace, intervalMs = 3000, names = SETTINGS_COLLECTIONS }) {
    this.read = read;
    this.replace = replace;
    this.intervalMs = intervalMs;
    this.names = names;
    this.last = new Map();
    this.timer = null;
    this.busy = false;
  }

  /** One pass. Returns the names of the collections that changed. */
  async syncNow() {
    if (this.busy) return [];
    this.busy = true;
    const changed = [];
    try {
      for (const name of this.names) {
        const docs = await this.read(name);
        const sig = stable(docs);
        if (this.last.get(name) === sig) continue;
        await this.replace(name, docs);
        this.last.set(name, sig);
        changed.push(name);
      }
    } catch (err) {
      logger.warn(`Could not read the live settings for the replay: ${err.message}`);
    } finally {
      this.busy = false;
    }
    return changed;
  }

  start() {
    this.timer = setInterval(() => this.syncNow(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** The real adapters: read the live database through a second connection, write into this process's (replay) database. */
export async function mongoSettingsSync({ sourceUri, intervalMs }) {
  const src = await mongoose.createConnection(sourceUri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  const sync = new SettingsSync({
    intervalMs,
    read: (name) => src.db.collection(name).find({}).toArray(),
    replace: async (name, docs) => {
      const col = mongoose.connection.db.collection(name);
      const paused = new Map((await col.find({ pausedOn: { $ne: null } }, { projection: { pausedOn: 1 } }).toArray()).map((d) => [String(d._id), d.pausedOn]));
      const keep = (d) => (paused.has(String(d._id)) ? { ...d, pausedOn: paused.get(String(d._id)) } : d);
      if (docs.length) await col.bulkWrite(docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: keep(d), upsert: true } })), { ordered: false });
      await col.deleteMany({ _id: { $nin: docs.map((d) => d._id) } });
    },
  });
  const stop = sync.stop.bind(sync);
  sync.stop = () => {
    stop();
    src.close().catch(() => {});
  };
  return sync;
}
