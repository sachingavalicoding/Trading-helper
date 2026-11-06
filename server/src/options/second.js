// Helpers for acting on the second instead of waiting for a candle to close (Account > Entries, "Act on the second").

const SLOT = 300; // seconds in a 5-minute bar

/** The 5-minute bar being formed now: the 1-minute bars of this slot, with the live price as its high, low and close. */
export function formingBar(c1, ltp, nowSec) {
  const time = nowSec - (nowSec % SLOT);
  const part = (c1 ?? []).filter((b) => b.time >= time && b.time < time + SLOT);
  if (!part.length) return { time, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 };
  return {
    time,
    open: part[0].open,
    high: Math.max(ltp, ...part.map((b) => b.high)),
    low: Math.min(ltp, ...part.map((b) => b.low)),
    close: ltp,
    volume: part.reduce((s, b) => s + (b.volume || 0), 0),
  };
}

/** True when the finished bars end right before the slot `nowSec` is in, so the forming bar can follow them. */
export const followsSlot = (done5, nowSec) => Boolean(done5?.length) && done5.at(-1).time + SLOT === nowSec - (nowSec % SLOT);

/**
 * "The signal has to stay true for N seconds in a row": the first second a key is seen starts the clock, and it is ready once
 * that many seconds have passed with the key seen on every check. `prune` forgets keys that were not true this round.
 */
export class Holds {
  constructor() {
    this.since = new Map();
  }

  held(key, nowMs, seconds) {
    if (!this.since.has(key)) this.since.set(key, nowMs);
    return nowMs - this.since.get(key) >= seconds * 1000;
  }

  prune(activeKeys) {
    for (const key of this.since.keys()) if (!activeKeys.has(key)) this.since.delete(key);
  }
}
