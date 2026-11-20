// @ts-check
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { AutoSettings, CandleDay, OptionSettings, TradeDefaults } from '../models/index.js';
import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { unpackCandles } from '../market/historyStore.js';
import { NIFTY50 } from '../market/instruments.js';
import { UNDERLYING } from '../options/symbols.js';
import { addDays } from '../market/days.js';
import { runSharesStudy } from '../study/sharesStudy.js';
import { shareSettingsOf, shareTrades } from '../learner/shareTune.js';
import { learnContext, dayKey } from '../learner/learnRun.js';
import { settingsOf, INDEX, FILL_SLIPPAGE } from '../learner/learnService.js';
import { analyzeSharesLab } from '../lab/sharesLab.js';
import { normalizeCombos } from '../combos/combos.js';
import { settingsFileOf, onlySide, sidePart, testDays } from '../dayreplay/ladder.js';
import { badRequest, conflict } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Research > Year test: ONE thing (the score bot, or one combination) played over months of the year candle files (Research > Data),
// shares or options, in a fast mode: the same engines Learn uses (study/sharesStudy.js + learner/shareTune.js for the share scanner,
// lab/sharesLab.js for a share combination, learner/learnRun.js for Nifty options), not the full Replay, which takes minutes a day.
// It runs on the server month by month, saves each month as it finishes (a file per user, never the database), carries on by itself
// after a restart, and changes no setting. Options premiums are ESTIMATED by the model over these months (only ~30 days of real option
// prices exist). At the end the fast mode is played against the full Replay engine on the newest days both have, and the gap is shown.

export const SCORE_ENTRIES = ['Breakout', 'Reversal', 'Pullback resume']; // the score bot's own entries (its trigger kinds)
export const MAX_TRADE_CHOICES = [2, 3, 4, 5];
export const MAX_WITH = 2; // combinations that may trade alongside the score bot in a test
export const SHARE_SETUPS = ['Opening range breakout', 'Gap and go', 'VWAP pullback', 'Level retest', 'News gap', 'Trend score'];
export const MONTH_CHOICES = [1, 3, 6, 12];
export const SHARE_SLIPPAGE_PCT = 0.05; // shares: each fill 0.05% worse (the shares study and Lab); options: 0.5% (FILL_SLIPPAGE, as Replay test)
export const CHECK_DAYS = 2;
export const CHECK_MS = 15 * 60_000; // the Replay check gives up after this long (a slow or busy computer), and says so
const SHARE_BLOCK = 5; // the share scanner replay slows down with the length of the candles it is given, so it is fed 5 days at a time
const WARM_SHARES = 7; // calendar days before a block, for the scanner's indicators
const WARM_OPTIONS = 40; // calendar days before a month: the score reads the last month's daily bars
const EJSON = mongoose.mongo.BSON.EJSON;
const r2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;
const monthOf = (/** @type {string} */ d) => d.slice(0, 7);

/** The candles of the year files on the server and of the imported files, read straight from them (never the trading database). */
export class YearSource {
  /** @param {{ yearFiles: any, imports: any }} o */
  constructor({ yearFiles, imports }) {
    this.yearFiles = yearFiles;
    this.imports = imports;
    /** @type {Map<string, any[]>} */
    this.open = new Map();
  }

  /** The year objects of a group ('nifty' or 'shares'), server files first, then imports. Kept until `close`. */
  async objects(/** @type {string} */ group) {
    if (this.open.has(group)) return /** @type {any[]} */ (this.open.get(group));
    const out = [];
    for (const f of await this.yearFiles.list()) if (f.name.startsWith(`${group}-`)) out.push(await this.yearFiles.load(group, Number(f.name.slice(group.length + 1, group.length + 5))));
    for (const m of await this.imports.list()) if (m.group === group) out.push(await this.imports.object(m.id).catch(() => null));
    const list = out.filter(Boolean);
    this.open.set(group, list);
    return list;
  }

  close() {
    this.open.clear();
  }

  /** What the files of a group hold, from their small summaries (no year file is opened). */
  async cover(/** @type {string} */ group) {
    const metas = [...(await this.yearFiles.list()).filter((f) => f.name.startsWith(`${group}-`)), ...(await this.imports.list()).filter((m) => m.group === group)].filter((m) => m.from);
    if (!metas.length) return { from: null, to: null, days: 0 };
    return { from: metas.map((m) => m.from).sort()[0], to: metas.map((m) => m.to).sort().at(-1), days: metas.reduce((n, m) => n + (m.days || 0), 0) };
  }

  /** The days with candles of a symbol (the Nifty for 'nifty'), oldest first. */
  async days(/** @type {string} */ group, symbol = UNDERLYING) {
    const set = new Set();
    for (const o of await this.objects(group)) for (const d of Object.keys(o.symbols?.[symbol] ?? {})) set.add(d);
    return [...set].sort();
  }

  /** 1-minute candles of one symbol from `from` to `to` (day keys), oldest first; a day in two files is read once. */
  async candles(/** @type {string} */ group, /** @type {string} */ symbol, /** @type {string} */ from, /** @type {string} */ to) {
    /** @type {Map<string, any>} */
    const byDay = new Map();
    for (const o of await this.objects(group)) {
      for (const [d, v] of Object.entries(o.symbols?.[symbol] ?? {})) if (d >= from && d <= to && !byDay.has(d)) byDay.set(d, v);
    }
    return [...byDay.keys()].sort().flatMap((d) => unpackCandles(Buffer.from(byDay.get(d).d, 'base64'), byDay.get(d).n));
  }

  async history(/** @type {string} */ from, /** @type {string} */ to) {
    /** @type {Record<string, any[]>} */
    const out = {};
    for (const { symbol } of NIFTY50) {
      const c = await this.candles('shares', symbol, from, to);
      if (c.length > 100) out[symbol] = c;
    }
    return out;
  }
}

/** What a run plays: the fixed copy of the settings taken when it started, cut down to the one thing tested. */
export function cutDown(/** @type {any} */ spec, /** @type {any} */ docs) {
  const d = EJSON.parse(EJSON.stringify(docs));
  if (spec.side === 'options') {
    const o = (d.optionsettings ??= {});
    o.enabled = true;
    o.patternEntries = false;
    o.scoreEntries = spec.what === 'score';
    const withIds = spec.what === 'score' ? spec.with ?? [] : [spec.combo];
    o.combos = normalizeCombos(o.combos ?? []).map((c) => ({ ...c, on: withIds.includes(c.id) }));
    if (spec.maxTrades) o.maxTrades = spec.maxTrades;
  } else {
    const a = (d.autosettings ??= {});
    a.enabled = true;
    a.combos = normalizeCombos(a.combos ?? []).map((c) => ({ ...c, on: spec.what === 'combo' && c.id === spec.combo }));
    if (spec.what === 'combo') Object.assign(a, { skipSetups: [...SHARE_SETUPS], trendScore: false, earlyNews: false });
    else if (spec.entry && spec.entry !== 'all') Object.assign(a, { skipSetups: SHARE_SETUPS.filter((s) => s !== spec.entry), trendScore: spec.entry === 'Trend score' || a.trendScore === true, earlyNews: spec.entry === 'News gap' || a.earlyNews !== false });
  }
  return onlySide(d, spec.side);
}

/** Totals of a list of trades ({ day, net, entry }). */
export function totals(/** @type {any[]} */ trades) {
  const wins = trades.filter((t) => t.net > 0).length;
  return { trades: trades.length, wins, winRate: trades.length ? Math.round((wins / trades.length) * 100) : 0, net: r2(trades.reduce((s, t) => s + t.net, 0)) };
}

/** The result of a run: totals, each month, each entry, best and worst month, profit without the best day, and the untouched days apart. */
export function summary(/** @type {any} */ run, /** @type {string | null} */ tunedFrom) {
  const months = (run.months ?? []).filter((/** @type {any} */ m) => m.done);
  const trades = months.flatMap((/** @type {any} */ m) => m.trades);
  const by = (/** @type {(t: any) => string} */ key) => {
    /** @type {Map<string, any[]>} */
    const m = new Map();
    for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return [...m.entries()].map(([k, ts]) => ({ key: k, ...totals(ts) }));
  };
  const perMonth = months.map((/** @type {any} */ m) => ({ key: m.month, days: m.days.length, seconds: m.seconds, ...totals(m.trades) }));
  const perDay = by((t) => t.day).sort((a, b) => b.net - a.net);
  const all = totals(trades);
  const bestDay = perDay[0] ?? null;
  const ranked = [...perMonth].sort((a, b) => b.net - a.net);
  const days = months.reduce((n, /** @type {any} */ m) => n + m.days.length, 0);
  const seconds = months.reduce((n, /** @type {any} */ m) => n + (m.seconds || 0), 0);
  const untouched = tunedFrom ? trades.filter((t) => t.day < tunedFrom) : trades;
  return {
    ...all,
    days,
    greenDays: perDay.filter((d) => d.net > 0).length,
    redDays: perDay.filter((d) => d.net < 0).length,
    perMonth,
    perEntry: by((t) => t.entry).sort((a, b) => b.net - a.net),
    bestMonth: ranked[0] ?? null,
    worstMonth: ranked.length > 1 ? ranked.at(-1) : null,
    bestDay: bestDay ? { day: bestDay.key, net: bestDay.net } : null,
    withoutBestDay: bestDay ? r2(all.net - bestDay.net) : 0,
    worstDay: perDay.length ? { day: perDay.at(-1).key, net: perDay.at(-1).net } : null,
    untouched: { from: tunedFrom, days: new Set(untouched.map((t) => t.day)).size, ...totals(untouched) },
    secondsPerDay: days ? r2(seconds / days) : null,
    seconds: Math.round(seconds),
  };
}

/** Is the fast mode close to the full Replay on the checked days? */
export function checkVerdict(/** @type {any[]} */ rows) {
  const ok = rows.filter((r) => r.full && r.fast);
  if (!ok.length) return { trusted: null, text: 'No day could be checked.' };
  const f = { trades: ok.reduce((s, r) => s + r.fast.trades, 0), net: ok.reduce((s, r) => s + r.fast.net, 0) };
  const p = { trades: ok.reduce((s, r) => s + r.full.trades, 0), net: ok.reduce((s, r) => s + r.full.net, 0) };
  const tradeGap = Math.abs(f.trades - p.trades);
  const netGap = Math.abs(f.net - p.net);
  const trusted = tradeGap <= Math.max(1, Math.round(0.25 * Math.max(f.trades, p.trades))) && netGap <= Math.max(800 * ok.length, 0.3 * Math.abs(p.net));
  const words = `On ${ok.length} day(s): fast ${f.trades} trades, ₹${Math.round(f.net)}; full Replay ${p.trades} trades, ₹${Math.round(p.net)}.`;
  return { trusted, text: trusted ? `${words} Close enough: the fast result can be used as a guide.` : `${words} They differ a lot: do NOT trust the fast result; it only shows a direction.` };
}

export class YearTest {
  /** @param {{ dir: string, yearFiles: any, imports: any, lab: any, ladder?: any, now?: () => Date }} o */
  constructor({ dir, yearFiles, imports, lab, ladder = null, now = () => new Date() }) {
    this.dir = dir;
    this.source = new YearSource({ yearFiles, imports });
    this.lab = lab;
    this.ladder = ladder;
    this.now = now;
    /** @type {{ userId: string, stopped: boolean, step: string } | null} */
    this.job = null;
  }

  #file(/** @type {string} */ userId) {
    if (!/^[a-f0-9]{24}$/.test(String(userId))) throw badRequest('Bad user');
    return path.join(this.dir, `${userId}.json`);
  }

  async #load(/** @type {string} */ userId) {
    try {
      return EJSON.parse(await readFile(this.#file(userId), 'utf8'));
    } catch {
      return null;
    }
  }

  async #save(/** @type {string} */ userId, /** @type {any} */ run) {
    await mkdir(this.dir, { recursive: true });
    const file = this.#file(userId);
    await writeFile(`${file}.tmp`, EJSON.stringify(run));
    await rename(`${file}.tmp`, file);
  }

  /** The first day the saved candles in the database start: everything Learn and the studies tuned on is from this day on. */
  async #tunedFrom() {
    const first = await CandleDay.findOne({ symbol: UNDERLYING }, 'day').sort({ day: 1 }).lean().catch(() => null);
    return /** @type {any} */ (first)?.day ?? null;
  }

  async view(/** @type {string} */ userId) {
    const [run, auto, opt, nifty, shares, tunedFrom] = await Promise.all([
      this.#load(userId),
      AutoSettings.findOne({ user: userId }, 'combos').lean(),
      OptionSettings.findOne({ user: userId }, 'combos').lean(),
      this.source.cover('nifty'),
      this.source.cover('shares'),
      this.#tunedFrom(),
    ]);
    const running = this.job?.userId === String(userId);
    const shown = run ? { spec: run.spec, state: running ? run.state : ['running', 'checking'].includes(run.state) ? 'stopped' : run.state, step: running ? this.job?.step : '', error: run.error ?? '', startedAt: run.startedAt, finishedAt: run.finishedAt, label: run.label, months: (run.months ?? []).map((/** @type {any} */ m) => ({ month: m.month, done: Boolean(m.done), days: m.days?.length ?? 0 })), result: summary(run, tunedFrom), check: run.check ?? null } : null;
    return {
      run: shown,
      data: { nifty, shares },
      combos: {
        shares: normalizeCombos(/** @type {any} */ (auto)?.combos ?? []).map((c) => ({ id: c.id, name: c.name })),
        options: normalizeCombos(/** @type {any} */ (opt)?.combos ?? []).filter((c) => !c.index || c.index === INDEX).map((c) => ({ id: c.id, name: c.name })),
      },
      setups: SHARE_SETUPS,
      scoreEntries: SCORE_ENTRIES,
      maxTradeChoices: MAX_TRADE_CHOICES,
      maxWith: MAX_WITH,
      monthChoices: MONTH_CHOICES,
      tunedFrom,
    };
  }

  /** Starts a run in the background: a fixed copy of the settings now, the months to play, one file. */
  async start(/** @type {string} */ userId, /** @type {any} */ body) {
    if (this.job) throw conflict('A year test is already running. Stop it first.');
    const spec = { side: body.side === 'options' ? 'options' : 'shares', what: body.what === 'combo' ? 'combo' : 'score', entry: body.entry || 'all', combo: body.combo || null, months: MONTH_CHOICES.includes(Number(body.months)) ? Number(body.months) : 6, maxTrades: MAX_TRADE_CHOICES.includes(Number(body.maxTrades)) ? Number(body.maxTrades) : null, with: [] };
    if (spec.side === 'options' && spec.what === 'score') {
      spec.with = [...new Set(Array.isArray(body.with) ? body.with.map(String) : [])].slice(0, MAX_WITH);
      if (spec.entry !== 'all' && !SCORE_ENTRIES.includes(spec.entry)) throw badRequest('Unknown score entry');
    }
    if (spec.side === 'shares') spec.maxTrades = null;
    const [o, a, t] = await Promise.all([OptionSettings.findOne({ user: userId }).lean(), AutoSettings.findOne({ user: userId }).lean(), TradeDefaults.findOne({ user: userId }).lean()]);
    const docs = { optionsettings: o, autosettings: a, tradedefaults: t };
    if (spec.what === 'combo') {
      const list = normalizeCombos((spec.side === 'options' ? o : a)?.combos ?? []);
      const c = list.find((x) => x.id === spec.combo);
      if (!c) throw badRequest('Pick one of your combinations.');
      spec.comboName = c.name;
    }
    if (spec.with.length) {
      const list = normalizeCombos(o?.combos ?? []);
      spec.withNames = spec.with.map((id) => list.find((x) => x.id === id)?.name).filter(Boolean);
      if (spec.withNames.length !== spec.with.length) throw badRequest('Pick your own combinations to trade with the score bot.');
    }
    if (spec.side === 'shares' && spec.what === 'score' && spec.entry !== 'all' && !SHARE_SETUPS.includes(spec.entry)) throw badRequest('Unknown entry');
    const niftyDays = await this.source.days('nifty');
    const haveDays = spec.side === 'shares' ? new Set(await this.source.days('shares', NIFTY50[0].symbol)) : null;
    const usable = niftyDays.filter((d) => !haveDays || haveDays.has(d));
    if (usable.length < 3) this.source.close();
    if (usable.length < 3) throw badRequest(spec.side === 'shares' ? 'No year files of the Nifty AND the 50 shares. Download or import them in Research > Saved data.' : 'No Nifty year file. Download or import it in Research > Saved data.', 'NO_DATA');
    const months = [...new Set(usable.map(monthOf))].slice(-spec.months);
    const days = usable.filter((d) => months.includes(monthOf(d)));
    // the fast engines' inputs, worked out once from the copy of the settings so a resumed run plays exactly the same thing
    const cut = cutDown(spec, docs);
    let engine;
    if (spec.side === 'options') {
      const params = await this.lab.optionParams(userId, INDEX);
      const settings = settingsOf(cut.optionsettings, t);
      Object.assign(params, { scoreEntries: spec.what === 'score', scoreMin: o?.minScore ?? 70, comboMinScore: o?.comboMinScore ?? 0, patternMinScore: o?.patternMinScore ?? 0, slippage: FILL_SLIPPAGE, combos: settings.combos, scoreTags: spec.what === 'score' && spec.entry !== 'all' ? [spec.entry] : null });
      engine = { params, settings, budget: o?.budget ?? 60000 };
    } else if (spec.what === 'combo') {
      engine = { params: { ...(await this.lab.shareParams(userId)), slippagePct: SHARE_SLIPPAGE_PCT } };
    } else {
      const sp = await this.lab.shareParams(userId);
      engine = { settings: shareSettingsOf(cut.autosettings), auto: EJSON.parse(EJSON.stringify(cut.autosettings)), money: { riskAmount: sp.riskAmount, steps: sp.steps, exitMin: sp.exitMin, maxAmount: sp.maxAmount } };
    }
    const label = `${spec.side === 'shares' ? 'Shares' : 'Options'}: ${spec.what === 'combo' ? spec.comboName : spec.side === 'shares' && spec.entry !== 'all' ? `scanner, ${spec.entry} only` : spec.side === 'shares' ? 'scanner, all your switched-on setups' : `score bot${spec.entry !== 'all' ? `, ${spec.entry} only` : ''}${spec.withNames?.length ? ` + ${spec.withNames.join(' + ')}` : ''}`}${spec.maxTrades ? `, max ${spec.maxTrades} trades a day` : ''}`;
    const run = { spec, label, state: 'running', startedAt: this.now().toISOString(), finishedAt: null, error: '', docs, cut, engine, months: months.map((m) => ({ month: m, days: days.filter((d) => monthOf(d) === m), done: false, trades: [], seconds: 0 })), check: null };
    await this.#save(userId, run);
    this.#go(String(userId), run);
    return this.view(userId);
  }

  async stop(/** @type {string} */ userId) {
    if (this.job?.userId === String(userId)) this.job.stopped = true;
    if (this.job?.userId === String(userId)) /** @type {any} */ (this.job).runners?.forEach((/** @type {any} */ r) => r.stop());
    const run = await this.#load(userId);
    if (run && run.state === 'checking') {
      run.state = 'done';
      run.check = { rows: [], verdict: { trusted: null, text: 'The Replay check was stopped. Tap Check again to run it.' } };
      await this.#save(userId, run);
    } else if (run && run.state === 'running') {
      run.state = 'stopped';
      await this.#save(userId, run);
    }
    return this.view(userId);
  }

  /** Carries on a stopped (or cut-short) run from the first month not done. */
  async resume(/** @type {string} */ userId) {
    if (this.job) throw conflict('A year test is already running.');
    const run = await this.#load(userId);
    if (!run) throw badRequest('No year test to carry on.');
    run.state = 'running';
    run.error = '';
    await this.#save(userId, run);
    this.#go(String(userId), run);
    return this.view(userId);
  }

  /** At start-up: a run the server was in the middle of carries on by itself. */
  async resumeAll() {
    let names = [];
    try {
      names = (await readdir(this.dir)).filter((n) => /^[a-f0-9]{24}\.json$/.test(n));
    } catch {
      return;
    }
    for (const n of names) {
      const userId = n.slice(0, 24);
      const run = await this.#load(userId);
      if ((run?.state === 'running' || run?.state === 'checking') && !this.job) {
        logger.info(`Year test of ${userId}: carrying on after a restart`);
        this.#go(userId, run);
      }
    }
  }

  #go(/** @type {string} */ userId, /** @type {any} */ run) {
    const job = { userId, stopped: false, step: 'Starting' };
    this.job = job;
    this.#run(job, run)
      .catch(async (e) => {
        logger.warn(`Year test failed: ${e.message}`);
        Object.assign(run, { state: 'failed', error: String(e.message).slice(0, 300), finishedAt: this.now().toISOString() });
        await this.#save(userId, run).catch(() => {});
      })
      .finally(() => {
        if (this.job === job) this.job = null;
        this.source.close();
      });
  }

  async #run(/** @type {any} */ job, /** @type {any} */ run) {
    for (const [n, m] of run.months.entries()) {
      if (job.stopped) return;
      if (m.done) continue;
      job.step = `Month ${n + 1} of ${run.months.length} (${m.month})`;
      const t0 = Date.now();
      m.trades = await this.playDays(run, m.days, (/** @type {string} */ s) => { job.step = `Month ${n + 1} of ${run.months.length} (${m.month}): ${s}`; });
      if (job.stopped) return;
      m.seconds = Math.round((Date.now() - t0) / 1000);
      m.done = true;
      await this.#save(job.userId, run);
      logger.info(`Year test ${m.month}: ${m.trades.length} trades, ${m.seconds} s`);
    }
    run.state = 'checking';
    run.finishedAt = this.now().toISOString(); // the year result is complete here; only the Replay check is left
    await this.#save(job.userId, run);
    job.step = `The result is complete. Checking it against the full Replay on ${CHECK_DAYS} days (up to ${Math.round((this.checkMs ?? CHECK_MS) / 60000)} min)`;
    run.check = await this.#crossCheck(job, run).catch((e) => ({ rows: [], verdict: { trusted: null, text: `The check could not run: ${e.message}` } }));
    if (job.stopped) return;
    Object.assign(run, { state: 'done', finishedAt: this.now().toISOString() });
    await this.#save(job.userId, run);
  }

  /**
   * The trades of the fast mode on some days (all in one month or fewer), as { day, t, side, entry, net }.
   * @param {any} run
   * @param {string[]} days
   */
  async playDays(run, days, onStep = (/** @type {string} */ _s) => {}) {
    if (!days.length) return [];
    const { spec, engine } = run;
    const first = days[0];
    const last = days.at(-1);
    if (spec.side === 'options') {
      onStep('reading candles');
      const nifty1 = await this.source.candles('nifty', UNDERLYING, addDays(first, -WARM_OPTIONS), last);
      const h = await this.source.history(addDays(first, -WARM_OPTIONS), last);
      const stocks5 = Object.keys(h).length ? Object.fromEntries(Object.entries(h).map(([s, c]) => [s, aggregateCandles(c, '5m')])) : null;
      const ctx = learnContext({ nifty1, stocks5, book: null, params: { ...engine.params }, days, budget: engine.budget });
      onStep('working out the chart score at each 5-minute close');
      await ctx.warm();
      onStep('trading');
      const trades = await ctx.evaluate(engine.settings);
      const names = new Map((engine.settings.combos ?? []).map((/** @type {any} */ c) => [`combo:${c.id}`, c.name]));
      return trades.map((/** @type {any} */ x) => ({ day: dayKey(x.entryTime), t: x.entryTime, side: x.side, entry: x.technique === 'score' || x.technique === 'bot' ? `Score: ${x.tag || 'no trigger'}` : names.get(x.technique) ?? spec.comboName ?? x.technique, net: r2(x.net) }));
    }
    if (spec.what === 'combo') {
      onStep('reading candles');
      const nifty1 = await this.source.candles('nifty', UNDERLYING, addDays(first, -WARM_SHARES), last);
      const history = await this.source.history(addDays(first, -WARM_SHARES), last);
      onStep('trading the combination on the 50 shares');
      const ctx = analyzeSharesLab({ nifty1, history, params: engine.params, base: `combo:${spec.combo}`, from: first, to: last, rank: false });
      const daySet = new Set(days);
      return ctx.baseRun.trades.map((/** @type {any} */ x) => ({ day: dayKey(x.entryTime), t: x.entryTime, side: x.side === 'CE' ? 'BUY' : 'SELL', entry: `${spec.comboName} (${x.side === 'CE' ? 'buys' : 'sells'})`, net: r2(x.net), symbol: x.symbol })).filter((/** @type {any} */ x) => daySet.has(x.day));
    }
    const out = [];
    for (let i = 0; i < days.length; i += SHARE_BLOCK) {
      const block = days.slice(i, i + SHARE_BLOCK);
      onStep(`scanner on the 50 shares, ${block[0]} to ${block.at(-1)}`);
      const nifty1 = await this.source.candles('nifty', UNDERLYING, addDays(block[0], -WARM_SHARES), block.at(-1));
      const history = await this.source.history(addDays(block[0], -WARM_SHARES), block.at(-1));
      const r = /** @type {any} */ (await runSharesStudy({ nifty1, history, params: { days: block.length, ...engine.money, slippagePct: SHARE_SLIPPAGE_PCT, settings: engine.auto, liveOnly: true } }));
      const set = new Set(block);
      for (const x of shareTrades(r.live, engine.settings, r.opts)) if (set.has(x.day)) out.push({ day: x.day, t: x.entryTime, side: x.side, entry: x.setup, net: r2(x.net) });
    }
    return out;
  }

  /** The newest days both the year files and the saved Replay days have, played both ways: fast here, full in the Replay test copies. */
  async #crossCheck(/** @type {any} */ job, /** @type {any} */ run) {
    const ladder = this.ladder;
    if (!ladder?.runners?.length) return { rows: [], verdict: { trusted: null, text: 'Full Replay is not available on this server, so the fast mode was not checked.' } };
    if (ladder.job || ladder.runners.some((/** @type {any} */ r) => r.busy)) return { rows: [], verdict: { trusted: null, text: 'A Replay test was running, so the check was skipped. Tap Check again later.' } };
    if (run.spec.side === 'options' && run.spec.what === 'score' && run.spec.entry !== 'all') return { rows: [], verdict: { trusted: null, text: 'Full Replay cannot play one score entry alone, so this run was not checked. Check a run with all score entries.' } };
    const saved = new Set((await testDays()).map((d) => d.day));
    const niftyDays = await this.source.days('nifty');
    const shareDays = run.spec.side === 'shares' ? new Set(await this.source.days('shares', NIFTY50[0].symbol)) : null;
    const days = niftyDays.filter((d) => saved.has(d) && (!shareDays || shareDays.has(d))).slice(-CHECK_DAYS);
    if (!days.length) return { rows: [], verdict: { trusted: null, text: 'No day is in both the year files and the saved Replay days, so the fast mode was not checked. Download the year files again to include recent days.' } };
    const settings = settingsFileOf(run.cut);
    const slippagePct = run.spec.side === 'options' ? FILL_SLIPPAGE * 100 : SHARE_SLIPPAGE_PCT;
    ladder.borrowed = true;
    const used = days.map((_, i) => ladder.runners[i % ladder.runners.length]);
    job.runners = used;
    let timer = null;
    let late = false;
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => {
        late = true;
        used.forEach((r) => r.stop());
        resolve(null);
      }, this.checkMs ?? CHECK_MS);
    });
    try {
      const all = Promise.all(
        days.map(async (day, i) => {
          if (job.stopped) return { day };
          const runner = ladder.runners[i % ladder.runners.length];
          const [fast, full] = await Promise.all([
            this.playDays(run, [day]).then((ts) => totals(ts)),
            runner.runDay({ day, settings, slippagePct, fillDelaySec: 2 }).then((/** @type {any} */ r) => sidePart(r, run.spec.side)).catch((/** @type {any} */ e) => ({ error: e.message })),
          ]);
          return { day, fast, full: full.error ? null : { trades: full.trades, net: r2(full.net) }, error: full.error ?? null };
        }),
      );
      const rows = await Promise.race([all, limit]);
      if (late || !rows) return { at: this.now().toISOString(), rows: [], verdict: { trusted: null, text: `The full Replay of ${days.length} day(s) took more than ${Math.round((this.checkMs ?? CHECK_MS) / 60000)} minutes (the computer is slow or busy), so it was stopped and the fast mode was not checked. The year result itself is complete. Tap Check again when the computer is free.` } };
      return { at: this.now().toISOString(), rows, verdict: checkVerdict(rows) };
    } finally {
      clearTimeout(timer);
      job.runners = null;
      ladder.borrowed = false;
    }
  }

  /** For tests: the check of a run, as it runs at the end. */
  check2(/** @type {any} */ job, /** @type {any} */ run) {
    return this.#crossCheck(job, run);
  }

  /** The check alone, again, on a finished run. */
  async check(/** @type {string} */ userId) {
    if (this.job) throw conflict('A year test is already running.');
    const run = await this.#load(userId);
    if (!run || !['done', 'stopped', 'failed'].includes(run.state)) throw badRequest('Run a year test first.');
    const job = { userId: String(userId), stopped: false, step: 'Checking the fast mode against the full Replay' };
    this.job = job;
    const before = run.state;
    run.state = 'checking';
    await this.#save(userId, run);
    this.#crossCheck(job, run)
      .catch((e) => ({ rows: [], verdict: { trusted: null, text: `The check could not run: ${e.message}` } }))
      .then(async (c) => {
        Object.assign(run, { check: c, state: before });
        await this.#save(userId, run);
      })
      .finally(() => {
        if (this.job === job) this.job = null;
        this.source.close();
      });
    return this.view(userId);
  }
}
