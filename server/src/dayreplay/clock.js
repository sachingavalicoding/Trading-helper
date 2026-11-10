// The clock of a replay run. Replaying a day means the whole app must believe it is that day, so the process's own clock
// (`new Date()` and `Date.now()`) is replaced by a virtual one that starts on the chosen day at the chosen time and runs at 1x to 50x.
// This is only ever installed in the separate replay process (see dayreplay/boot.js); the live server never calls installClock.

const RealDate = Date;

export class ReplayClock {
  /** @param {number} startMs virtual start (epoch ms), @param {number} endMs virtual end: the clock stops there */
  /**
   * @param {number} maxStepMs  the most real time one step may count (see `step`). A busy phone that answers late then makes the replay run
   *                            slower instead of jumping ahead. Infinity (the default) counts all of it.
   */
  constructor({ startMs, endMs, speed = 1, realNow = () => RealDate.now(), maxStepMs = Infinity }) {
    this.realNow = realNow;
    this.maxStepMs = maxStepMs;
    this.holds = 0; // jobs that asked the clock to wait for them (utils/every.js)
    this.startMs = startMs;
    this.endMs = endMs;
    this.speed = speed;
    this.paused = false;
    this.baseVirtual = startMs;
    this.baseReal = realNow();
  }

  now() {
    if (this.paused || this.holds > 0) return this.baseVirtual;
    return Math.min(this.baseVirtual + Math.min(this.realNow() - this.baseReal, this.maxStepMs) * this.speed, this.endMs);
  }

  /** Called by the feed on each poll: counts the real time since the last step, at most `maxStepMs` of it. */
  step() {
    this.#rebase();
  }

  /** A job is running that must see every moment (a bot scan): the clock waits for it. Every hold needs one release. */
  hold() {
    if (this.holds === 0) this.#rebase();
    this.holds += 1;
  }

  release() {
    if (this.holds === 0) return;
    if (--this.holds === 0) this.baseReal = this.realNow(); // the time spent waiting does not count
  }

  #rebase() {
    this.baseVirtual = this.now();
    this.baseReal = this.realNow();
  }

  setSpeed(speed) {
    if (!(speed > 0)) return;
    this.#rebase();
    this.speed = speed;
  }

  pause() {
    this.#rebase();
    this.paused = true;
  }


  resume() {
    if (this.finished) return;
    this.#rebase();
    this.paused = false;
  }

  get finished() {
    return this.now() >= this.endMs;
  }

  info() {
    return { virtualNow: this.now(), speed: this.speed, busy: this.holds > 0, paused: this.paused || this.finished, finished: this.finished, startMs: this.startMs, endMs: this.endMs };
  }
}

/** Makes `new Date()` and `Date.now()` answer with the clock's time. Dates made from arguments are untouched, and real Dates still pass `instanceof Date`. Returns a function that puts the real clock back. */
export function installClock(clock) {
  function ReplayDate(...args) {
    if (!new.target) return new RealDate(clock.now()).toString();
    return args.length === 0 ? new RealDate(clock.now()) : new RealDate(...args);
  }
  Object.setPrototypeOf(ReplayDate, RealDate);
  ReplayDate.prototype = RealDate.prototype;
  ReplayDate.now = () => clock.now();
  globalThis.Date = ReplayDate;
  globalThis.__replayClock = clock; // timers follow it too (utils/every.js)
  return () => {
    globalThis.Date = RealDate;
    delete globalThis.__replayClock;
  };
}
