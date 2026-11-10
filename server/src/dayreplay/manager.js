import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TickChunk } from '../models/TickChunk.js';
import { logger } from '../utils/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(here, '../index.js');
export const SPEEDS = [1, 2, 5, 10, 25, 50];

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
  }

  get port() {
    return this.config.replayPort || this.config.port + 1;
  }

  /** Days that have recorded seconds, newest first, with how many saved chunks each holds. */
  async days() {
    const rows = await TickChunk.aggregate([{ $group: { _id: '$day', chunks: { $sum: 1 }, seconds: { $sum: '$count' } } }, { $sort: { _id: -1 } }]);
    return rows.map((r) => ({ day: r._id, chunks: r.chunks, rows: r.seconds }));
  }

  status() {
    return { ...this.run, port: this.run.state === 'idle' ? null : this.port };
  }

  async start({ day, speed = 1 }) {
    if (!SPEEDS.includes(speed)) throw Object.assign(new Error(`Speed must be one of ${SPEEDS.join(', ')}`), { status: 400, code: 'BAD_SPEED' });
    if (!(await this.days()).some((d) => d.day === day)) throw Object.assign(new Error(`There are no recorded seconds for ${day}`), { status: 400, code: 'NO_DAY' });
    await this.#halt();
    const run = { state: 'starting', day, speed, startedAt: Date.now() };
    this.run = run;
    const child = this.spawnFn(process.execPath, [SERVER_ENTRY], {
      cwd: path.resolve(here, '../..'),
      env: { ...process.env, REPLAY_DAY: day, REPLAY_SPEED: String(speed), PORT: String(this.port), REPLAY_SOURCE_MONGO_URI: this.config.mongoUri, REPLAY_LIVE_PORT: String(this.config.port) },
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
