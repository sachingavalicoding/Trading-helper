// The clock of a replay run. Replaying a day means the whole app must believe it is that day, so the process's own clock
// (`new Date()` and `Date.now()`) is replaced by a virtual one that starts on the chosen day at the chosen time and runs at 1x, 10x or 60x.
// This is only ever installed in the separate replay process (see dayreplay/boot.js); the live server never calls installClock.

const RealDate = Date;

export class ReplayClock {
  /** @param {number} startMs virtual start (epoch ms), @param {number} endMs virtual end: the clock stops there */
  constructor({ startMs, endMs, speed = 1, realNow = () => RealDate.now() }) {
    this.realNow = realNow;
    this.startMs = startMs;
    this.endMs = endMs;
    this.speed = speed;
    this.paused = false;
    this.baseVirtual = startMs;
    this.baseReal = realNow();
  }

  now() {
    if (this.paused) return this.baseVirtual;
    return Math.min(this.baseVirtual + (this.realNow() - this.baseReal) * this.speed, this.endMs);
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
    return { virtualNow: this.now(), speed: this.speed, paused: this.paused || this.finished, finished: this.finished, startMs: this.startMs, endMs: this.endMs };
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
  return () => {
    globalThis.Date = RealDate;
  };
}
