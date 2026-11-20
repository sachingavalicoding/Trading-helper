import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TickChunk } from '../models/TickChunk.js';
import { logger } from '../utils/logger.js';
import { testDays } from './ladder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(here, '../index.js');
export const SPEEDS = [1, 2, 5, 10, 25, 50, 100, 200];
export const SAFE_MAX_SPEED = 50; // faster only after a speed check found the same trades (dayreplay/speedCheck.js)

/** The speeds that may be picked: up to 50x, and 100x/200x once `fastOk`. */
export const allowedSpeeds = (fastOk) => SPEEDS.filter((s) => s <= SAFE_MAX_SPEED || fastOk);

/**
 * Runs a replay as a second copy of this server on another port, with its own database and virtual clock, so the live server and its
 * paper history are never touched. Only the live server has a manager; the replay copy has none (a replay cannot start another).
 */
export class ReplayManager {
  constructor({ config, spawnFn = spawn, fetchFn = fetch, readyTimeoutMs = 120000 }) {
    this.config = config;
    this.spawnFn = spawnFn;
    this.fetchFn = fetchFn;
    this.readyTimeoutMs = readyTimeoutMs;
    this.child = null;
    this.run = { state: 'idle' };
    this.speedCheck = null; // set by index.js
  }

  get fastOk() {
    return Boolean(this.speedCheck?.fastOk);
  }

  get port() {
    return this.config.replayPort || this.config.port + 1;
  }

  /**
   * Days that can be replayed, newest first: every day whose Nifty 1-minute candles and option prices were saved. `seconds` says the day
   * also has the 1-second record (the newest few days), which a replay plays only when asked.
   */
  async days() {
    const rows = await TickChunk.aggregate([{ $group: { _id: '$day', chunks: { $sum: 1 }, seconds: { $sum: '$count' } } }]);
    const ticks = new Map(rows.map((r) => [r._id, r]));
    const minute = await testDays();
    const listed = new Set(minute.map((d) => d.day));
    const extra = [...ticks.keys()].filter((d) => !listed.has(d)).map((day) => ({ day, seconds: true, minutes: false }));
    return [...minute.map((d) => ({ ...d, minutes: true })), ...extra]
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((d) => ({ ...d, rows: ticks.get(d.day)?.seconds ?? 0 }));
  }

  status() {
    return { ...this.run, port: this.run.state === 'idle' ? null : this.port };
  }

  async start({ day, speed = 1, seconds = false }) {
    if (!SPEEDS.includes(speed)) throw Object.assign(new Error(`Speed must be one of ${SPEEDS.join(', ')}`), { status: 400, code: 'BAD_SPEED' });
    if (!allowedSpeeds(this.fastOk).includes(speed)) throw Object.assign(new Error(`${speed}x needs a passed speed check first (Replay > Check 200x). Use ${SAFE_MAX_SPEED}x or slower.`), { status: 400, code: 'SPEED_NOT_CHECKED' });
    const known = (await this.days()).find((d) => d.day === day);
    if (!known) throw Object.assign(new Error(`Nothing was saved for ${day}`), { status: 400, code: 'NO_DAY' });
    if (!known.minutes && !seconds) seconds = true; // only the seconds were saved for that day
    if (seconds && !known.seconds) throw Object.assign(new Error(`${day} has no 1-second record; replay it on 1-minute candles`), { status: 400, code: 'NO_SECONDS' });
    await this.#halt();
    const run = { state: 'starting', day, speed, seconds, startedAt: Date.now() };
    this.run = run;
    const child = this.spawnFn(process.execPath, [SERVER_ENTRY], {
      cwd: path.resolve(here, '../..'),
      env: { ...process.env, REPLAY_DAY: day, REPLAY_SPEED: String(speed), REPLAY_SECONDS: seconds ? '1' : '0', REPLAY_FAST: this.fastOk ? '1' : '0', REPLAY_TEST: '0', PORT: String(this.port), REPLAY_SOURCE_MONGO_URI: this.config.mongoUri, REPLAY_LIVE_PORT: String(this.config.port) },
      stdio: 'inherit',
    });
    this.child = child;
    child.on('exit', (code) => {
      if (this.run === run) this.run = { state: code === 0 || run.stopping ? 'idle' : 'failed', day, speed, error: code === 0 || run.stopping ? undefined : `The replay stopped (code ${code}). See the server log.` };
      if (this.child === child) this.child = null;
    });
    child.on('error', (err) => {
      if (this.run === run) this.run = { state: 'failed', day, speed, error: err.message };
    });
    this.#waitReady(run);
    return this.status();
  }

  async #waitReady(run) {
    const until = Date.now() + this.readyTimeoutMs;
    while (this.run === run && Date.now() < until) {
      try {
        const res = await this.fetchFn(`http://127.0.0.1:${this.port}/api/health`);
        if (res.ok) {
          if (this.run === run) this.run = { ...run, state: 'ready' };
          return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (this.run === run) {
      logger.warn('Replay did not start in time');
      this.run = { state: 'failed', day: run.day, speed: run.speed, error: 'The replay did not start in time. See the server log.' };
      this.child?.kill();
    }
  }

  /** Stops the running copy and waits until it has really exited (its port and database are free), killing it if it is slow. */
  async #halt(timeoutMs = 10000) {
    const child = this.child;
    this.stop();
    if (!child || child.exitCode !== null || child.signalCode) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        setTimeout(resolve, 500);
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  stop() {
    if (this.child) {
      this.run.stopping = true;
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.run = { state: 'idle' };
    return this.status();
  }
}

/** What the routes need: a manager in the live server, the clock in a replay copy. */
export function dayReplayRoutesDeps({ config, clock, ...bots }) {
  const manager = config.replay ? null : new ReplayManager({ config });
  if (manager) process.on('exit', () => manager.child?.kill());
  return { config, clock, manager, ...bots };
}
