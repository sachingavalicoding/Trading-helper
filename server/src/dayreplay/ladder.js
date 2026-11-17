import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { AutoSettings, CandleDay, LearnerState, OptionCandleDay, OptionSettings, ReplayTest, TradeDefaults } from '../models/index.js';
import { TickChunk } from '../models/TickChunk.js';
import { normalizeCombos } from '../combos/combos.js';
import { INDEX, KIND, savePatch, withParts } from '../learner/learnService.js';
import { sharePatch } from '../learner/shareTune.js';
import { UNDERLYING } from '../options/symbols.js';
import { istParts } from '../market/marketHours.js';
import { badRequest, conflict } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { TEST_SPEED } from './testRunner.js';

// Replay test, step by step ("step-up"): plays the chosen past days with your settings as they are now, then tries each change Learn
// suggested, one at a time, on top of the best so far. A change is KEPT only if it makes more money over all the days AND more on the
// newest days (the hidden days, a third of them), so a change that only fits the older days is dropped. Each run uses its own copy of the
// settings, never the live ones. Nothing is applied by itself: Apply puts the kept changes in place, only when at least one was kept and
// your settings are still the ones it tested. The daily loss limit is never changed by a test or by Apply.

export const DAY_CHOICES = [3, 5, 10, 15];
export const SLIPPAGE_CHOICES = [0, 0.25, 0.5, 1]; // % worse than the price seen
export const DELAY_CHOICES = [0, 2, 5, 10]; // seconds before a market order fills
export const PARALLEL_CHOICES = [1, 2, 3, 4]; // days played side by side (each a copy of the server: more needs a stronger computer)
/** Which bot a change touches: an options change only needs the options bot replayed, a shares change only the shares bot. */
const SIDE = { setup: 'options', combo: 'options', shares: 'shares' };
const NAMES = { optionsettings: OptionSettings.collection.name, autosettings: AutoSettings.collection.name, tradedefaults: TradeDefaults.collection.name };
const EJSON = mongoose.mongo.BSON.EJSON;
const r2 = (n) => Math.round(n * 100) / 100;

/** How many of the newest days are the hidden check: a third, at least one. */
export const hiddenCount = (n) => Math.max(1, Math.round(n / 3));

/** Totals of one setup over the days. */
export function summarize(results, hidden = []) {
  const nets = results.map((r) => r.net);
  const trades = results.reduce((s, r) => s + r.trades, 0);
  const wins = results.reduce((s, r) => s + r.wins, 0);
  const worst = results.reduce((w, r) => (!w || r.net < w.net ? r : w), null);
  return {
    days: results.length,
    net: r2(nets.reduce((s, x) => s + x, 0)),
    trades,
    wins,
    winRate: trades ? Math.round((wins / trades) * 100) : 0,
    worstDay: worst ? { day: worst.day, net: worst.net } : null,
    badDays: results.filter((r) => r.net < 0).length,
    hiddenNet: r2(results.filter((r) => hidden.includes(r.day)).reduce((s, r) => s + r.net, 0)),
    options: r2(results.reduce((s, r) => s + (r.options?.net ?? 0), 0)),
    shares: r2(results.reduce((s, r) => s + (r.shares?.net ?? 0), 0)),
  };
}

const none = { trades: 0, wins: 0, net: 0, charges: 0 };

/**
 * One day of a change that touched only one bot: that bot's part from the new run, the other bot's part from the best run so far (the
 * other bot's settings are the same, so it would trade the same). The two bots only meet through the paper money they share.
 */
export function mergeSide(best, run, side) {
  const options = (side === 'options' ? run.options : best.options) ?? none;
  const shares = (side === 'shares' ? run.shares : best.shares) ?? none;
  return {
    day: best.day,
    trades: options.trades + shares.trades,
    wins: options.wins + shares.wins,
    net: r2(options.net + shares.net),
    charges: r2((options.charges ?? 0) + (shares.charges ?? 0)),
    options,
    shares,
    stillOpen: run.stillOpen ?? 0,
    reused: side === 'options' ? 'shares' : 'options',
  };
}

/** A copy of the settings with the other bot switched off, so a run plays only the bot the change touches. */
export function onlySide(docs, side) {
  const out = clone(docs);
  if (side === 'options' && out.autosettings) out.autosettings.enabled = false;
  if (side === 'shares' && out.optionsettings) out.optionsettings.enabled = false;
  return out;
}

/** Does `cand` beat `best`? It must earn more over all the days AND more on the hidden (newest) days. */
export function beats(cand, best) {
  if (cand.net <= best.net) return { ok: false, why: `Earned ₹${cand.net} over all the days, not more than the best so far (₹${best.net}).` };
  if (cand.hiddenNet <= best.hiddenNet) return { ok: false, why: `More over all the days (₹${cand.net} vs ₹${best.net}) but not on the newest days (₹${cand.hiddenNet} vs ₹${best.hiddenNet}): it only fits the older days.` };
  return { ok: true, why: `More over all the days (₹${cand.net} vs ₹${best.net}) and on the newest days (₹${cand.hiddenNet} vs ₹${best.hiddenNet}).` };
}

const setPath = (doc, key, value) => {
  const parts = key.split('.');
  let o = doc;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = value;
};

/** A deep copy that keeps ObjectIds and Dates. */
export const clone = (docs) => EJSON.parse(EJSON.stringify(docs));

/** A short fingerprint of a user's settings documents, to tell whether they changed after a test. */
export const fingerprintDocs = (docs) => createHash('sha1').update(EJSON.stringify(docs)).digest('hex').slice(0, 16);

/**
 * The changes Learn suggested that a test can try, in the order they are tried: the whole options setup, then each combination, then
 * shares. Each has `apply(docs)` that writes it into a copy of the settings documents ({ optionsettings: doc, autosettings: doc, tradedefaults: doc }).
 * Results already applied (and not undone) or without changes are left out. The daily loss limit is never part of a change.
 */
export function ladderCandidates(st) {
  const out = [];
  const last = st?.last;
  if (last?.proposal && last.changes?.length && !(last.applied && !last.undone)) {
    out.push({
      key: 'setup',
      kind: 'setup',
      name: 'Options: whole setup from Learn',
      changes: last.changes.map((c) => c.label).filter((l) => !/daily loss/i.test(l)),
      verdict: last.verdict,
      apply(docs) {
        const raw = docs.optionsettings ?? {};
        const others = normalizeCombos(raw.combos ?? []).filter((c) => c.index && c.index !== INDEX);
        const p = savePatch(last.proposal, others);
        const { dailyLossPct: _keep, ...options } = p.options; // the daily loss limit stays yours
        docs.optionsettings = { ...raw, ...options };
        const td = (docs.tradedefaults ??= {});
        setPath(td, 'options.stopLoss', p.rules.stopLoss);
        setPath(td, 'options.steps', p.rules.steps);
        setPath(td, 'options.lockOn', p.rules.lockOn);
      },
    });
  }
  for (const r of st?.combos?.list ?? []) {
    if (!r?.proposal || !r.changes?.length || (r.applied && !r.undone)) continue;
    out.push({
      key: `combo:${r.id}`,
      kind: 'combo',
      id: r.id,
      name: `Combination: ${r.name}`,
      changes: r.changes.map((c) => c.label),
      verdict: r.verdict,
      apply(docs) {
        const raw = docs.optionsettings ?? {};
        const list = normalizeCombos(raw.combos ?? []);
        const at = list.findIndex((c) => c.id === r.id);
        if (at < 0) return false;
        list[at] = withParts(list[at], r.proposal);
        docs.optionsettings = { ...raw, combos: normalizeCombos(list) };
        return true;
      },
    });
  }
  const sh = st?.shares;
  if (sh?.proposal && sh.changes?.length && !(sh.applied && !sh.undone)) {
    out.push({
      key: 'shares',
      kind: 'shares',
      name: 'Shares from Learn',
      changes: sh.changes.map((c) => c.label),
      verdict: sh.verdict,
      apply(docs) {
        const a = { ...(docs.autosettings ?? {}) };
        for (const [k, v] of Object.entries(sharePatch(sh.proposal))) setPath(a, k, v);
        docs.autosettings = a;
      },
    });
  }
  return out;
}

/** The settings documents of one user, as the seed of a test run wants them (collection name -> docs). */
export function settingsFileOf(docs) {
  return EJSON.stringify({
      [NAMES.optionsettings]: docs.optionsettings ? [docs.optionsettings] : [],
      [NAMES.autosettings]: docs.autosettings ? [docs.autosettings] : [],
      [NAMES.tradedefaults]: docs.tradedefaults ? [docs.tradedefaults] : [],
    });
}

/** Days a test can play, newest first: the Nifty's 1-minute candles and option prices were saved; `seconds` tells which also have the 1-second record (not used by a test). */
export async function testDays(now = new Date()) {
  const [nifty, opts, ticks] = await Promise.all([CandleDay.distinct('day', { symbol: UNDERLYING }), OptionCandleDay.distinct('day'), TickChunk.distinct('day')]);
  const ist = istParts(now);
  const optSet = new Set(opts);
  const tickSet = new Set(ticks);
  // today only once the evening save is in (after 15:40 IST)
  return nifty
    .filter((d) => optSet.has(d) && (d < ist.dateKey || (d === ist.dateKey && ist.minutes >= 15 * 60 + 40)))
    .sort((a, b) => b.localeCompare(a))
    .map((day) => ({ day, seconds: tickSet.has(day) }));
}

/** Runs the step-up tests, one at a time, through a TestRunner, and keeps the state in ReplayTest. */
export class ReplayLadder {
  constructor({ runner = null, runners = null, learn = null }) {
    this.runners = runners ?? [runner];
    this.learn = learn;
    this.job = null; // { userId, stop }
  }

  async #liveDocs(userId) {
    const [o, a, t] = await Promise.all([OptionSettings.findOne({ user: userId }).lean(), AutoSettings.findOne({ user: userId }).lean(), TradeDefaults.findOne({ user: userId }).lean()]);
    return { optionsettings: o, autosettings: a, tradedefaults: t };
  }

  async view(userId) {
    const [saved, st, days] = await Promise.all([ReplayTest.findOne({ user: userId }).lean(), LearnerState.findOne({ user: userId, kind: KIND }).lean(), testDays()]);
    // a test cut short by a restart of the app shows as stopped
    const test = saved?.state === 'running' && this.job?.userId !== String(userId) ? { ...saved, state: 'stopped', error: 'The app restarted while the test ran. Start it again.' } : saved;
    const candidates = ladderCandidates(st).map(({ key, kind, name, changes, verdict }) => ({ key, kind, name, changes, verdict }));
    let stale = false;
    if (test?.state === 'done' && test.base) stale = fingerprintDocs(await this.#liveDocs(userId)) !== test.base;
    return { test: test ?? null, running: this.job?.userId === String(userId), candidates, days, stale, choices: { days: DAY_CHOICES, slippage: SLIPPAGE_CHOICES, delay: DELAY_CHOICES, parallel: PARALLEL_CHOICES.filter((n) => n <= this.runners.length) }, speed: TEST_SPEED };
  }

  async start(userId, { days: count, slippagePct = 0.5, fillDelaySec = 2, parallel = 2 }) {
    const side = Math.max(1, Math.min(parallel, this.runners.length));
    if (this.job) throw conflict('A replay test is already running. Stop it first.');
    if (!DAY_CHOICES.includes(count)) throw badRequest(`Pick ${DAY_CHOICES.join(', ')} days`);
    const st = await LearnerState.findOne({ user: userId, kind: KIND }).lean();
    const cands = ladderCandidates(st);
    if (!cands.length) throw badRequest('Learn has no suggested change to test. Run Learn first (Research > Learn).');
    const avail = await testDays();
    if (avail.length < count) throw badRequest(`Only ${avail.length} saved day(s) can be played.`);
    const days = avail.slice(0, count).map((d) => d.day).reverse(); // oldest first
    const hidden = days.slice(-hiddenCount(count));
    const live = await this.#liveDocs(userId);
    const steps = [{ key: 'now', kind: 'now', name: 'Your settings now', changes: [], verdict: 'waiting', results: [] }, ...cands.map(({ key, kind, id, name, changes }) => ({ key, kind, id, name, changes, verdict: 'waiting', results: [] }))];
    const test = await ReplayTest.findOneAndUpdate(
      { user: userId },
      { $set: { state: 'running', days, hidden, fill: { slippagePct, fillDelaySec, parallel: side }, steps, at: null, base: fingerprintDocs(live), error: '', startedAt: new Date(), finishedAt: null, applied: null } },
      { upsert: true, new: true },
    );
    const job = { userId: String(userId), stopped: false };
    this.job = job;
    this.#run(job, test._id, live, cands, { days, hidden, slippagePct, fillDelaySec, parallel: side }).finally(() => {
      if (this.job === job) this.job = null;
    });
    return this.view(userId);
  }

  async #save(id, set) {
    await ReplayTest.updateOne({ _id: id }, { $set: set });
  }

  /**
   * Plays every day with one set of settings, `o.parallel` days at a time (each runner its own copy of the server and database; the days
   * do not depend on each other, so the result is the same as one by one). Saves the days as they finish. With `side`, only that bot plays
   * and the other bot's part of each day comes from `bestResults`.
   */
  async #playAll(job, id, stepIndex, docs, o, side = null, bestResults = null) {
    const settings = settingsFileOf(side ? onlySide(docs, side) : docs);
    const results = new Array(o.days.length).fill(null);
    let next = 0;
    let failed = null;
    await this.#save(id, { at: { step: stepIndex, day: o.days[0] }, [`steps.${stepIndex}.verdict`]: 'running' });
    const worker = async (runner) => {
      while (!job.stopped && !failed && next < o.days.length) {
        const i = next++;
        const day = o.days[i];
        try {
          const r = await runner.runDay({ day, settings, slippagePct: o.slippagePct, fillDelaySec: o.fillDelaySec });
          results[i] = side ? mergeSide(bestResults[i], r, side) : r;
          await this.#save(id, { at: { step: stepIndex, day: o.days[Math.min(next, o.days.length - 1)] }, [`steps.${stepIndex}.results`]: results.filter(Boolean) });
        } catch (err) {
          failed ??= err;
          for (const other of this.runners) other.stop();
        }
      }
    };
    await Promise.all(this.runners.slice(0, o.parallel ?? 1).map(worker));
    if (failed && !job.stopped) throw failed;
    return job.stopped ? null : results;
  }

  async #run(job, id, live, cands, o) {
    try {
      let best = clone(live);
      let bestResults = await this.#playAll(job, id, 0, best, o);
      if (!bestResults) return;
      let bestSum = summarize(bestResults, o.hidden);
      await this.#save(id, { 'steps.0.verdict': 'base', 'steps.0.summary': bestSum, 'steps.0.why': 'What your settings earn now. Each change below must beat the best so far.' });
      let setupKept = false;
      for (let i = 0; i < cands.length; i += 1) {
        const c = cands[i];
        const at = i + 1;
        if (c.kind === 'combo' && setupKept) {
          await this.#save(id, { [`steps.${at}.verdict`]: 'skipped', [`steps.${at}.why`]: 'Skipped: the whole setup that was kept brings its own combinations.' });
          continue;
        }
        const docs = clone(best);
        if (c.apply(docs) === false) {
          await this.#save(id, { [`steps.${at}.verdict`]: 'skipped', [`steps.${at}.why`]: 'Skipped: that combination is no longer saved.' });
          continue;
        }
        // a change to one bot replays only that bot; the other bot's days are the best run's
        const results = await this.#playAll(job, id, at, docs, o, SIDE[c.kind] ?? null, bestResults);
        if (!results) return;
        const sum = summarize(results, o.hidden);
        const b = beats(sum, bestSum);
        await this.#save(id, { [`steps.${at}.verdict`]: b.ok ? 'kept' : 'dropped', [`steps.${at}.why`]: b.why, [`steps.${at}.summary`]: sum });
        if (b.ok) {
          best = docs;
          bestSum = sum;
          bestResults = results;
          if (c.kind === 'setup') setupKept = true;
        }
      }
      await this.#save(id, { state: 'done', at: null, finishedAt: new Date() });
    } catch (err) {
      if (job.stopped || err.stopped) return;
      logger.warn(`Replay test failed: ${err.message}`);
      await this.#save(id, { state: 'failed', error: err.message, at: null, finishedAt: new Date() }).catch(() => {});
    } finally {
      if (job.stopped) await this.#save(id, { state: 'stopped', at: null, finishedAt: new Date() }).catch(() => {});
    }
  }

  async stop(userId) {
    if (this.job?.userId === String(userId)) {
      this.job.stopped = true;
      for (const r of this.runners) r.stop();
    }
    return this.view(userId);
  }

  /**
   * Puts the kept changes in place, through Learn's own Apply (so Learn's track record follows them). Only after a finished test that kept
   * at least one change, and only while the settings are still the ones it tested. The daily loss limit is put back as it was.
   */
  async apply(userId) {
    if (!this.learn) throw badRequest('Apply is not available here.');
    const test = await ReplayTest.findOne({ user: userId });
    if (!test || test.state !== 'done') throw badRequest('Finish a replay test first.');
    if (test.applied) throw conflict('Already applied.');
    const kept = test.steps.filter((s) => s.verdict === 'kept');
    if (!kept.length) throw conflict('No change beat your settings on the newest days, so there is nothing to apply.');
    const live = await this.#liveDocs(userId);
    if (fingerprintDocs(live) !== test.base) throw conflict('Your settings changed after this test. Run the test again.');
    const dailyLossPct = live.optionsettings?.dailyLossPct;
    const done = [];
    for (const s of kept) {
      if (s.kind === 'setup') await this.learn.apply(userId, { force: true });
      else if (s.kind === 'combo') await this.learn.applyCombo(userId, s.id, { force: true });
      else if (s.kind === 'shares') await this.learn.applyShares(userId, { force: true });
      done.push(s.name);
    }
    if (dailyLossPct != null) await OptionSettings.updateOne({ user: userId }, { $set: { dailyLossPct } });
    test.applied = { at: new Date(), steps: done };
    await test.save();
    return this.view(userId);
  }
}
