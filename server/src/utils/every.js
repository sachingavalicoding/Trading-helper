// Runs a job again and again, `ms` apart, and never starts a run while the last one is still going.
//
// On a live day that is a plain timer. In a day replay the process's clock is a virtual one (dayreplay/clock.js) that can run 50 times faster
// than the real one, so a real-time timer would scan once every 12 virtual minutes and miss most 5-minute bars, and the work would pile up.
// There the job runs every `ms` of virtual time instead, and the replay clock is held while a run is busy: the replay then slows down to
// what the phone can manage rather than skipping bars or hanging.

const MAX_HOLD_MS = 10_000; // a run that takes longer than this (a stuck network call) stops holding the clock

/** The replay clock when this process is a replay, else null. */
export const replayClock = () => globalThis.__replayClock ?? null;

/**
 * @param {number} ms   how often, in milliseconds of the app's clock (virtual in a replay)
 * @param {() => any} fn the job (sync or async); errors are passed to `onError`
 * @returns {{ stop(): void }}
 */
export function every(ms, fn, { onError = () => {}, clock = replayClock() } = {}) {
  let busy = false;
  let stopped = false;
  let last = clock ? clock.now() : 0;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    let released = false;
    let guard = null;
    if (clock) {
      clock.hold();
      guard = setTimeout(() => {
        if (!released) {
          released = true;
          clock.release();
        }
      }, MAX_HOLD_MS);
      guard.unref?.();
    }
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      busy = false;
      if (clock) {
        clearTimeout(guard);
        if (!released) {
          released = true;
          clock.release();
        }
      }
    }
  };
  let timer;
  if (!clock) {
    timer = setInterval(run, ms);
  } else {
    timer = setInterval(() => {
      if (busy) return;
      const now = clock.now();
      if (now - last < ms) return;
      last = now;
      run();
    }, Math.max(20, Math.min(ms, 100)));
  }
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
