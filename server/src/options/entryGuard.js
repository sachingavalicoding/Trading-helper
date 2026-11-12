import { randomUUID } from 'node:crypto';
import { KeyedMutex } from '../utils/keyedMutex.js';

// One new option buy per user at a time.
//
// 12 Nov 2026: the same combination bought NIFTY 25200 PE twice at 12:42 (2 lots each). The checks before a buy ("already holding a PE",
// trades open, budget left) read the database and then place the order a few awaits later, so two entries started together both saw
// "nothing held" and both bought; the engine added the second fill to the first position, making one 4-lot trade with twice the loss
// limit. Entries are now run one after another for each user, inside this process (a queue) and across processes that share the
// database (a claim row with a unique key), and the checks run again inside the guard, so the second entry sees the first one's position.

export const CLAIM_MS = 60_000;

/** A claim store backed by the EntryClaim collection. `model` is passed in so tests can use a stand-in. */
export function mongoClaims(model) {
  return {
    async take(key, owner, now) {
      try {
        // takes a free or stale claim; a live claim of someone else makes the upsert insert a duplicate key, which fails
        await model.updateOne({ key, until: { $lte: now } }, { $set: { owner, until: new Date(now.getTime() + CLAIM_MS) } }, { upsert: true });
        return true;
      } catch (e) {
        if (e?.code === 11000) return false;
        throw e;
      }
    },
    async drop(key, owner) {
      await model.deleteOne({ key, owner });
    },
  };
}

export class EntryGuard {
  /**
   * @param {{ take(key, owner, now): Promise<boolean>, drop(key, owner): Promise<void> }} claims
   * @param {() => Date} now
   */
  constructor({ claims, now = () => new Date(), owner = randomUUID() }) {
    this.claims = claims;
    this.now = now;
    this.owner = owner;
    this.queue = new KeyedMutex();
  }

  /**
   * Runs `fn` as the only option entry of `userId` in flight. Returns `fn`'s result, or `{ busy: true }` when another server holds the
   * claim (that server is buying for this user at this moment).
   */
  run(userId, fn) {
    const key = `OPT|${userId}`;
    return this.queue.run(key, async () => {
      if (!(await this.claims.take(key, this.owner, this.now()))) return { busy: true };
      try {
        return await fn();
      } finally {
        await this.claims.drop(key, this.owner).catch(() => {});
      }
    });
  }
}
