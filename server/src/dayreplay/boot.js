import { ReplayClock, installClock } from './clock.js';
import { ReplayProvider } from './ReplayProvider.js';
import { MongoSource } from './mongoSource.js';
import { seedReplayDb, replayUriFor, testUriFor } from './seed.js';
import { OPEN_MIN, CLOSE_MIN } from '../market/marketHours.js';
import { lotSizeOf } from '../options/symbols.js';
import { logger } from '../utils/logger.js';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

const IST_MS = 330 * 60000;
const atMinute = (day, minute) => Date.parse(`${day}T00:00:00Z`) - IST_MS + minute * 60000;

/**
 * Starts a replay run: copies the data into the separate replay database, then returns the Mongo address to use, the replay feed and its clock.
 * The process's own clock is replaced by the virtual one, so this must only run in the replay process.
 */
export async function prepareReplay(env) {
  const { day, speed, sourceMongoUri, seconds, test, settingsFile } = env.replay;
  const sourceUri = sourceMongoUri || env.mongoUri;
  const targetUri = test ? testUriFor(sourceUri, env.replay.slot) : replayUriFor(sourceUri);
  logger.info(`Replay of ${day}: copying the saved data into the test database`);
  // a test run trades with its own copy of the settings, written by the live server (EJSON keeps the ids as ids)
  const settings = test && settingsFile ? mongoose.mongo.BSON.EJSON.parse(readFileSync(settingsFile, 'utf8')) : null;
  const copied = await seedReplayDb({ sourceUri, targetUri, day, seconds, settings, priorDays: test ? 30 : 0 });
  if (!copied.niftyMinutes && !copied.ticks) throw new Error(`No saved Nifty candles for ${day}. Pick a day from the list in Account.`);
  const clock = new ReplayClock({ startMs: atMinute(day, OPEN_MIN), endMs: atMinute(day, CLOSE_MIN + 5), speed, maxStepMs: 500 }); // a busy phone slows the replay instead of jumping it ahead
  const provider = new ReplayProvider({ source: new MongoSource(day), clock, day, lotSize: lotSizeOf('NIFTY', env), useSeconds: Boolean(seconds && copied.ticks) });
  installClock(clock);
  logger.info(`Replay of ${day} ready at ${speed}x on ${seconds && copied.ticks ? `recorded seconds (${copied.ticks} chunks)` : '1-minute candles'}. Orders and positions are kept in the separate replay database.`);
  return { mongoUri: targetUri, sourceUri, provider, clock };
}
