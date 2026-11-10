import { ReplayClock, installClock } from './clock.js';
import { ReplayProvider } from './ReplayProvider.js';
import { MongoSource } from './mongoSource.js';
import { seedReplayDb, replayUriFor } from './seed.js';
import { OPEN_MIN, CLOSE_MIN } from '../market/marketHours.js';
import { lotSizeOf } from '../options/symbols.js';
import { logger } from '../utils/logger.js';

const IST_MS = 330 * 60000;
const atMinute = (day, minute) => Date.parse(`${day}T00:00:00Z`) - IST_MS + minute * 60000;

/**
 * Starts a replay run: copies the data into the separate replay database, then returns the Mongo address to use, the replay feed and its clock.
 * The process's own clock is replaced by the virtual one, so this must only run in the replay process.
 */
export async function prepareReplay(env) {
  const { day, speed, sourceMongoUri } = env.replay;
  const sourceUri = sourceMongoUri || env.mongoUri;
  const targetUri = replayUriFor(sourceUri);
  logger.info(`Replay of ${day}: copying the saved data into the test database`);
  const copied = await seedReplayDb({ sourceUri, targetUri, day });
  if (!copied.ticks) throw new Error(`No recorded seconds for ${day}. Pick a day from the list in Account.`);
  const clock = new ReplayClock({ startMs: atMinute(day, OPEN_MIN), endMs: atMinute(day, CLOSE_MIN + 5), speed });
  const provider = new ReplayProvider({ source: new MongoSource(day), clock, day, lotSize: lotSizeOf('NIFTY', env) });
  installClock(clock);
  logger.info(`Replay of ${day} ready at ${speed}x (${copied.ticks} saved chunks of seconds). Orders and positions are kept in the separate replay database.`);
  return { mongoUri: targetUri, provider, clock };
}
