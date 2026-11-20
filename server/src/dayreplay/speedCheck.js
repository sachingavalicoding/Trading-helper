import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { AutoSettings, OptionSettings, TradeDefaults } from '../models/index.js';
import { badRequest, conflict } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { settingsFileOf, testDays } from './ladder.js';

// The speed check: plays one saved day twice with the same (current) settings, once at 50x and once at a fast speed (200x), and compares
// every trade. Until a check passes, 100x and 200x are shown with a "not checked" warning, so a faster replay never quietly shows other trades.

export const SAFE_SPEED = 50;
export const FAST_SPEEDS = [100, 200];
const CHECK_SPEED = 200;
const TIME_SLACK_SEC = 60; // a trade may open or close in another second of the same minute and still count as the same

const key = (t) => `${t.symbol}|${t.side}`;
const near = (a, b, slack) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= slack);

/** Compares two lists of trades (dayreplay/result.js tradeList). Returns the differences in plain words; none means the same trades. */
export function compareTrades(slow, fast) {
  const diffs = [];
  if (slow.length !== fast.length) diffs.push(`${SAFE_SPEED}x made ${slow.length} trade(s), ${CHECK_SPEED}x made ${fast.length}`);
  const n = Math.min(slow.length, fast.length);
  for (let i = 0; i < n; i += 1) {
    const a = slow[i];
    const b = fast[i];
    const what = [];
    if (key(a) !== key(b)) what.push(`${a.side} ${a.symbol} vs ${b.side} ${b.symbol}`);
    if (!near(a.openedAt, b.openedAt, TIME_SLACK_SEC)) what.push('buy time');
    if (!near(a.closedAt, b.closedAt, TIME_SLACK_SEC)) what.push('exit time');
    if (!near(a.entry, b.entry, 0.01)) what.push(`entry ${a.entry} vs ${b.entry}`);
    if (!near(a.exit, b.exit, 0.01)) what.push(`exit ${a.exit} vs ${b.exit}`);
    if (!near(a.net, b.net, 1)) what.push(`P&L ${a.net} vs ${b.net}`);
    if (what.length) diffs.push(`Trade ${i + 1} (${a.symbol}): ${what.join(', ')}`);
  }
  return diffs;
}

/** Runs the speed check in the background on its own TestRunner; one at a time. `last` is what the Replay screen shows. */
export class SpeedCheck {
  /** @param {{ runner: any, file?: string|null, now?: () => number }} o  file: where the newest finished check is kept across restarts */
  constructor({ runner, file = null, now = () => Date.now() }) {
    this.runner = runner;
    this.file = file;
    this.now = now;
    this.last = { state: 'idle' };
    try {
      if (file) this.last = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* no check yet */
    }
  }

  #keep() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.last));
    } catch (err) {
      logger.warn(`Could not save the speed check: ${err.message}`);
    }
  }

  /** Fast speeds may be picked once the newest check passed. */
  get fastOk() {
    return this.last.state === 'done' && this.last.same === true;
  }

  view() {
    return { ...this.last, fastOk: this.fastOk, fastSpeeds: FAST_SPEEDS };
  }

  async start(userId, day) {
    if (this.last.state === 'running') throw conflict('A speed check is already running.');
    const days = await testDays();
    if (!days.some((d) => d.day === day)) throw badRequest(`${day} has no saved 1-minute candles and option prices, so it cannot be checked. Pick another day.`);
    const [o, a, t] = await Promise.all([OptionSettings.findOne({ user: userId }).lean(), AutoSettings.findOne({ user: userId }).lean(), TradeDefaults.findOne({ user: userId }).lean()]);
    const settings = settingsFileOf({ optionsettings: o, autosettings: a, tradedefaults: t });
    const id = (this.runId = (this.runId ?? 0) + 1);
    this.last = { state: 'running', day, step: `Playing ${day} at ${CHECK_SPEED}x`, startedAt: this.now() };
    this.#run(id, day, settings).catch((err) => {
      if (this.runId !== id) return; // stopped, or a newer check
      this.last = { state: 'failed', day, error: err.message };
      this.#keep();
    });
    return this.view();
  }

  async #play(day, settings, speed) {
    const t0 = this.now();
    const r = await this.runner.runDay({ day, settings, slippagePct: 0, fillDelaySec: 0, speed });
    return { speed, seconds: Math.round((this.now() - t0) / 1000), trades: r.list ?? [], net: r.net };
  }

  async #run(id, day, settings) {
    const fast = await this.#play(day, settings, CHECK_SPEED);
    if (this.runId !== id) return;
    this.last = { ...this.last, step: `Playing ${day} at ${SAFE_SPEED}x (the ${CHECK_SPEED}x run took ${fast.seconds} s)` };
    const slow = await this.#play(day, settings, SAFE_SPEED);
    if (this.runId !== id) return;
    const diffs = compareTrades(slow.trades, fast.trades);
    this.last = {
      state: 'done',
      day,
      same: diffs.length === 0,
      diffs: diffs.slice(0, 10),
      runs: [slow, fast].map(({ speed, seconds, trades, net }) => ({ speed, seconds, trades: trades.length, net })),
      savedSeconds: slow.seconds - fast.seconds,
      finishedAt: this.now(),
    };
    this.#keep();
    logger.info(`Speed check of ${day}: ${diffs.length ? `${diffs.length} difference(s)` : 'same trades'} (${SAFE_SPEED}x ${slow.seconds}s, ${CHECK_SPEED}x ${fast.seconds}s)`);
  }

  stop() {
    if (this.last.state !== 'running') return this.view();
    this.runId += 1;
    this.last = { state: 'idle' };
    this.runner.stop();
    return this.view();
  }
}
