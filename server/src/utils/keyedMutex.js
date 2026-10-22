// Serialises async work per key (we use the user id) so two fills for the same
// user can never interleave their wallet/position updates.
export class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }

  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(() => fn());
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
