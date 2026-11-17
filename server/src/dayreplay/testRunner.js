import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(here, '../index.js');
export const TEST_SPEED = 200; // a test day runs at 200x where the computer keeps up (about 2 minutes a day); the bots hold the clock while they think
const DAY_TIMEOUT_MS = 40 * 60_000;

/**
 * Runs ONE past day as a test: a copy of the server on its own port and its own database (`<db>_test_replay`), with the settings it is
 * given (never the live ones, never linked to them), at test speed, on 1-minute candles. Resolves with the day's result (dayreplay/result.js).
 */
export class TestRunner {
  constructor({ config, spawnFn = spawn }) {
    this.config = config;
    this.spawnFn = spawnFn;
    this.child = null;
  }

  get port() {
    return (this.config.replayPort || this.config.port + 1) + 1; // the hand replay has port + 1
  }

  get busy() {
    return Boolean(this.child);
  }

  /** @param {{ day: string, settings: string, slippagePct?: number, fillDelaySec?: number, speed?: number }} o  settings: EJSON of the settings documents */
  runDay({ day, settings, slippagePct = 0, fillDelaySec = 0, speed = TEST_SPEED }) {
    if (this.child) return Promise.reject(new Error('A test day is already running'));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
    const settingsFile = path.join(dir, 'settings.json');
    const resultFile = path.join(dir, 'result.json');
    writeFileSync(settingsFile, settings);
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(process.execPath, [SERVER_ENTRY], {
        cwd: path.resolve(here, '../..'),
        env: {
          ...process.env,
          REPLAY_DAY: day,
          REPLAY_SPEED: String(speed),
          REPLAY_TEST: '1',
          REPLAY_SECONDS: '0',
          REPLAY_SETTINGS_FILE: settingsFile,
          REPLAY_RESULT_FILE: resultFile,
          REPLAY_SLIPPAGE_PCT: String(slippagePct),
          REPLAY_FILL_DELAY_SEC: String(fillDelaySec),
          PORT: String(this.port),
          REPLAY_PORT: '',
          REPLAY_SOURCE_MONGO_URI: this.config.mongoUri,
          REPLAY_LIVE_PORT: '',
          TICK_RECORD: 'false',
        },
        stdio: 'inherit',
      });
      this.child = child;
      const timer = setTimeout(() => {
        logger.warn(`Test day ${day} took too long, stopping it`);
        child.kill('SIGKILL');
      }, DAY_TIMEOUT_MS);
      timer.unref?.();
      const done = (err, out) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        rmSync(dir, { recursive: true, force: true });
        if (err) reject(err);
        else resolve(out);
      };
      child.on('error', (err) => done(err));
      child.on('exit', (code) => {
        let out = null;
        try {
          out = JSON.parse(readFileSync(resultFile, 'utf8'));
        } catch {
          /* no result */
        }
        if (child.stopped) return done(Object.assign(new Error('Stopped'), { stopped: true }));
        if (!out) return done(new Error(`The test of ${day} stopped without a result (code ${code}). See the server log.`));
        if (out.error) return done(new Error(`The test of ${day} failed: ${out.error}`));
        done(null, out);
      });
    });
  }

  stop() {
    if (!this.child) return;
    this.child.stopped = true;
    this.child.kill('SIGTERM');
  }
}
