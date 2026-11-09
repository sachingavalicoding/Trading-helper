import { AutoLog, OptionSettings, Order, Position, Trade } from '../models/index.js';
import { getFunds } from '../services/walletService.js';
import { INDEXES, DEFAULT_INDEX, INDEX_KEYS, indexKeyOf, isOptionSymbol, optionLabel, parseOptionSymbol } from './symbols.js';
import { forIndex } from './indexSettings.js';
import { readNifty, entryWindowOf, entryTest } from './signal.js';
import { breakEvenOf, trailOf } from '../study/simulate.js';
import { TECHNIQUES, prepare, findSignals, turnoverSeries, ruleStop, stopRuleOf, MIN_STOP_ATR, MAX_STOP_ATR } from '../study/patterns.js';
import { breadthSeries, lossesInARow } from '../study/optionsStudy.js';
import { buildChart } from '../combos/conditions.js';
import { comboSignals, normalizeCombos, comboFitsIndex } from '../combos/combos.js';
import { roundToTick } from '../utils/money.js';
import { planTrade } from './plan.js';
import { chaseOf, chaseRise, chaseSkip } from './chase.js';
import { movedOf, movedMeasures, movedSkip } from './moved.js';
import { dayBiasOf, dayStand, dayBiasSkip, streakSkip } from './dayBias.js';
import { formingBar, followsSlot, Holds } from './second.js';
import { loadRules } from '../models/TradeDefaults.js';
import { istParts } from '../market/marketHours.js';
import { logger } from '../utils/logger.js';

const round2 = (n) => Math.round(n * 100) / 100;

const SCAN_MS = 15000;
const SECOND_MS = 1000; // how often the "act on the second" entries look at the forming 5-minute bar
const SECOND_CACHE_MS = 5000; // who has the second switches on is read from the database this often
const COOLDOWN_AFTER_STOP_MIN = 20;
const SAME_SIDE_COOLDOWN_MIN = 15;
const LOG_REPEAT_MS = 30 * 60000; // the same skip reason is written to the log at most this often
export const PROBATION_TRADES = 10; // a combination is bought with 1 lot until it has this many closed live trades (switch: Options > Auto, "New combinations start small")
const PATTERN_FRESH_MS = 4 * 60000; // a pattern is acted on only while the 5-minute bar that completed it closed under 4 minutes ago

// The chart patterns the trader can buy on. The 30-day study (Options > Study) found these three made money on more than 12 trades each:
// breakout of the last hour (+13.4k, 76% win), inside bar breakout (+6.4k) and the EMA 9/21 cross (+2.5k). The 50-stock breadth needs history the live feed lacks.
export const LIVE_PATTERNS = TECHNIQUES.filter((t) => t.key !== 'breadth' && !t.needs).map((t) => ({ key: t.key, label: t.label }));
export const DEFAULT_PATTERNS = ['breakout', 'insideBar', 'emaCross'];

/**
 * Which entry sources are on for a user: the indicator score (all 15 chart checks add up to a score; it buys when the stronger side reaches
 * `minScore` with a fresh trigger and no hard check against it), the chosen chart patterns and the user's own combinations. The score is off
 * unless switched on (Account > Entries), so settings saved before it came back keep buying as they did.
 */
export function entryModes(settings) {
  const known = new Set(LIVE_PATTERNS.map((p) => p.key));
  const chosen = (settings.patterns ?? DEFAULT_PATTERNS).filter((k) => known.has(k));
  return { score: settings.scoreEntries === true, patterns: settings.patternEntries === false ? [] : chosen, combos: settings.comboEntries !== false && normalizeCombos(settings.combos).some((c) => c.on) };
}

/** The label a score entry is logged under: one name per trigger, so the losing-streak pause and the day report can group them. */
export const scoreLabel = (side) => `Score: ${side.trigger?.kind ?? 'no trigger'}`;

/** The indexes a user trades: those ticked in the settings (Nifty only when nothing was ever saved). */
export function activeIndexes(settings) {
  const chosen = (settings.indexes ?? []).filter((k) => INDEX_KEYS.includes(k));
  return chosen.length ? INDEX_KEYS.filter((k) => chosen.includes(k)) : [DEFAULT_INDEX];
}

/**
 * Paper options trader for Nifty 50 index options. Every 15 seconds it reads the chart of each index the user trades; when a chart
 * pattern or one of the user's combinations turns true it buys one at-the-money contract, sized so a stop at the chart level loses no more than the user's limit.
 * It sells when a 1-minute candle closes beyond that level; the profit lock is the user's rule from the Account tab, which the order
 * engine puts on every new position. It closes everything at the 15:15 square-off.
 * It only ever calls the paper order engine.
 */
export class OptionTrader {
  constructor({ market, engine, config, scanner = null, now = () => new Date() }) {
    this.market = market;
    this.engine = engine;
    this.config = config;
    this.scanner = scanner;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.open = new Map(); // `${userId}|${symbol}` -> what the trade needs watching for
    this.exiting = new Set();
    this.reasons = new Map(); // `${userId}|${symbol}` -> why we exited at market (STOP, TIME)
    this.logged = new Map(); // dedupe key -> time of the last log row
    this.patternSeen = new Set(); // `${userId}|${technique}|${bar time}`: each pattern is acted on once
    this.lastReads = new Map(); // index key -> the last chart read
    this.bars = new Map(); // index key -> the 1-minute bar being built from its ticks
    this.comboCharts = new Map(); // index key -> { time, chart }
    this.secondTimer = null;
    this.secondBusy = false;
    this.secondCacheAt = 0;
    this.secondUsers = []; // settings whose entry clock is 1 second or 1 minute (the 5-minute close is the normal scan)
    this.exitClocks = new Map(); // user id -> '1s' | '5m' when the chart stop is not the default 1-minute close
    this.minuteDone = new Map(); // user|index -> the minute a 1-minute entry check last ran
    this.bars5 = new Map(); // index key -> the 5-minute bar being built from its ticks
    this.secondExit = new Map(); // user id -> the minute they close, for the second entries
    this.holds = new Holds();
    this.onTick = (t) => this.#onTick(t);
    this.onUpdate = (u) => {
      if (u.kind === 'stopoff') {
        // the per-position stop switch: with it off, the chart stop, trailing stop and break-even leave this trade alone
        const w = this.open.get(`${u.userId}|${u.symbol}`);
        if (w) w.stopOff = Boolean(u.stopOff);
        return;
      }
      if (u.kind === 'fill' && u.order && isOptionSymbol(u.order.symbol) && u.order.role !== 'ENTRY') this.#finish(u).catch((e) => logger.warn(`options log update failed: ${e.message}`));
    };
  }

  /** Pick up trades that were open when the server last stopped, so their chart stops keep working. */
  async init() {
    for (const log of await AutoLog.find({ segment: 'OPT', status: 'OPEN' }).lean()) {
      this.#watch(log.user, log.symbol, {
        type: log.detail?.type,
        index: log.detail?.index ?? parseOptionSymbol(log.symbol)?.index ?? DEFAULT_INDEX,
        stopSpot: log.detail?.stopSpot,
        entry: log.fillPrice ?? log.entry,
        risk: Math.abs((log.fillPrice ?? log.entry) - log.stopLoss),
        openedAt: log.decidedAt,
        manual: Boolean(log.detail?.manual),
        entrySpot: log.detail?.entrySpot ?? null,
        trail: log.detail?.trail ?? null,
        breakEven: log.detail?.breakEven ?? 0,
        stopWhy: log.detail?.stopWhy ?? 'STOP',
        bestSpot: log.detail?.bestSpot ?? log.detail?.entrySpot ?? null,
        bestR: log.detail?.bestR ?? 0,
        worstR: log.detail?.worstR ?? 0,
        stopOff: Boolean(log.position && (await Position.findById(log.position, 'stopOff').lean())?.stopOff),
      });
      await this.market.watchOption(log.symbol, log.detail?.contract ?? null).catch(() => {});
    }
    // Any other open option position or resting order (placed by hand) also needs a live price to be managed.
    const symbols = new Set([...(await Position.distinct('symbol', { segment: 'OPT', status: 'OPEN' })), ...(await Order.distinct('symbol', { segment: 'OPT', status: 'OPEN' }))]);
    for (const symbol of symbols) await this.market.watchOption(symbol).catch(() => {});
  }

  start() {
    this.market.on('tick', this.onTick);
    this.engine.on('update', this.onUpdate);
    this.timer = setInterval(() => this.scan().catch((e) => logger.warn(`options scan failed: ${e.message}`)), SCAN_MS);
    this.timer.unref?.();
    this.secondTimer = setInterval(() => this.secondScan().catch((e) => logger.warn(`options second scan failed: ${e.message}`)), SECOND_MS);
    this.secondTimer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.secondTimer);
    this.market.off('tick', this.onTick);
    this.engine.off('update', this.onUpdate);
  }

  #watch(userId, symbol, info) {
    this.open.set(`${userId}|${symbol}`, { user: String(userId), symbol, ...info });
  }

  /** What one lot (or the lots the settings allow) of each side would be, shown before you buy: the same plan the trader would place. */
  async preview(userId, read, contracts) {
    const settings = forIndex((await OptionSettings.findOne({ user: userId }).lean()) || new OptionSettings({ user: userId }).toObject(), read.index);
    const [today, funds, rules] = await Promise.all([this.todaySummary(userId), getFunds(userId, this.config.startingBalance), loadRules(userId, 'OPT', { index: read.index })]);
    const out = {};
    for (const type of ['CE', 'PE']) {
      const contract = contracts[type];
      const side = read[type.toLowerCase()];
      if (!contract?.ltp || !side) {
        out[type] = { skipped: 'no live premium for the contract' };
        continue;
      }
      const planned = planTrade({ read: side, market: read.market, contract, premium: contract.ltp, settings, rules, available: funds.available, spentBudget: today.spent, now: this.now() });
      out[type] = planned.skipped ? { skipped: planned.skipped } : { plan: planned.plan };
    }
    return out;
  }

  /** The chart read of one index ('NIFTY'), both sides, as of now. */
  async read(index = DEFAULT_INDEX) {
    const symbol = INDEXES[index].symbol;
    const [c1, daily] = await Promise.all([this.market.getCandles(symbol, '1m'), this.market.getDaily(symbol).catch(() => [])]);
    const read = readNifty(
      { c1, daily, tick: this.market.getTick(symbol), breadthUp: this.scanner?.marketState?.breadthUp ?? null },
      { now: this.now(), enforceWindows: this.config.enforceMarketHours },
    );
    if (read.ready) {
      Object.defineProperty(read, 'c1', { value: c1, enumerable: false }); // the 1-minute bars, for the "already moved" check (kept out of logs and JSON)
      read.index = index;
      read.ce.index = index;
      read.pe.index = index;
    }
    this.lastReads.set(index, read);
    return read;
  }

  async scan() {
    if (this.running) return;
    this.running = true;
    try {
      const all = await OptionSettings.find({ enabled: true }).lean();
      if (!all.length && !this.open.size) return;
      for (const s of all) await this.manage(s.user).catch((e) => logger.warn(`options manage failed: ${e.message}`));
      if (!all.length) return;
      const status = this.engine.marketStatus();
      if (this.config.enforceMarketHours && !status.isOpen) return;
      const reads = new Map(); // one chart read per index per scan, shared by every user
      const readOf = async (index) => {
        if (!reads.has(index)) reads.set(index, await this.read(index));
        return reads.get(index);
      };
      const nowMin = istParts(this.now()).minutes;
      for (const s of all) {
        try {
          if (this.config.enforceMarketHours && nowMin >= (await loadRules(s.user, 'OPT')).exitMin) continue; // past the time you close: no new trade
          for (const index of activeIndexes(s)) {
            const si = forIndex(s, index);
            const modes = entryModes(si);
            const read = await readOf(index);
            if (modes.score) {
              const p = await this.considerScore(si, read);
              if (p.order) continue;
            }
            if (modes.patterns.length) {
              const p = await this.considerPatterns(si, read);
              if (p.order) continue;
            }
            if (modes.combos) await this.considerCombos(si, read);
          }
        } catch (e) {
          logger.warn(`options order failed: ${e.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ---------- numbers for the screens ----------

  /** Option trades today: entries, how many are open, and the money made or lost after charges. */
  async todaySummary(userId) {
    const day = this.engine.marketStatus().istDate;
    const [entries, open, trades] = await Promise.all([
      Order.countDocuments({ user: userId, segment: 'OPT', role: 'ENTRY', status: 'FILLED', tradingDay: day }),
      Position.find({ user: userId, segment: 'OPT', status: 'OPEN' }, 'margin').lean(),
      Trade.find({ user: userId, segment: 'OPT', tradingDay: day }, 'realizedPnl charges').lean(),
    ]);
    return {
      trades: entries,
      open: open.length,
      spent: round2(open.reduce((s, p) => s + p.margin, 0)),
      pnl: round2(trades.reduce((s, t) => s + (t.realizedPnl || 0) - (t.charges?.total || 0), 0)),
    };
  }

  // ---------- deciding ----------

  async #record(settings, extra) {
    try {
      return await AutoLog.create({ user: settings.user, day: this.engine.marketStatus().istDate, segment: 'OPT', ...extra });
    } catch (e) {
      logger.warn(`options log write failed: ${e.message}`);
      return null;
    }
  }

  /** Log a skip, but not the same one every 15 seconds. */
  async #skip(settings, side, reason, extra = {}) {
    const key = `${settings.user}|${side.type}|${reason.replace(/-?\d+(\.\d+)?/g, '#')}`;
    const prev = this.logged.get(key);
    if (prev && Date.now() - prev < LOG_REPEAT_MS) return { skipped: reason };
    this.logged.set(key, Date.now());
    await this.#record(settings, {
      symbol: `${side.index ?? DEFAULT_INDEX} ${side.type}`,
      side: 'BUY',
      setup: side.trigger?.kind,
      score: side.score,
      decision: 'SKIPPED',
      status: 'SKIPPED',
      reason,
      entry: undefined,
      card: { checks: side.checks, gates: side.gates },
      detail: { type: side.type, index: side.index ?? DEFAULT_INDEX, spot: this.lastReads.get(side.index ?? DEFAULT_INDEX)?.spot, ...extra },
    });
    return { skipped: reason };
  }

  /**
   * The score entry: every chart check (trend, EMAs, supertrend, ADX, RSI, MACD, levels, breadth, candle, Heikin-Ashi, stochastic, pivot range,
   * choppiness) adds points, and the stronger side is bought when its score reaches `minScore`, a fresh trigger (breakout, pullback-and-turn or
   * reversal) has fired, no hard check blocks it and the other side scores at least 10 less. The stop is the chart level of the read (moved by
   * the stop setting in Account > Limits unless that is "chart"). Acted on once per side per 5-minute bar, like a pattern.
   */
  async considerScore(settings, read) {
    if (!read?.ready) return { skipped: 'the chart is not ready yet' };
    const last = read.market.done5.at(-1);
    if (!last) return { skipped: 'no closed bar yet' };
    if (this.config.enforceMarketHours && !entryTest(entryWindowOf(settings))(last.time)) return { skipped: 'outside your entry hours' };
    const min = settings.minScore ?? 70;
    const side = read.best;
    if (!side) {
      // only a strong side that a hard check stopped is worth a log row; a quiet market is not a decision
      const lead = read.lead;
      if (lead && lead.score >= min && (!settings.sideOnly || lead.type === settings.sideOnly)) {
        const seen = `${settings.user}|${read.index}|score-blocked|${lead.type}|${last.time}`;
        if (this.patternSeen.has(seen)) return { skipped: 'already logged' };
        this.patternSeen.add(seen);
        return this.#skip(settings, { ...lead, trigger: { kind: scoreLabel(lead) } }, `Score ${lead.type} ${lead.score} but not bought: ${lead.blocked[0] || 'the other side scores nearly the same'}`);
      }
      return { skipped: 'no side scores high enough' };
    }
    if (settings.sideOnly && side.type !== settings.sideOnly) return { skipped: `${side.type} is not the side you trade` };
    if (side.score < min) return { skipped: `score ${side.score} is below ${min}` };
    const seen = `${settings.user}|${read.index}|score|${side.type}|${last.time}`;
    if (this.patternSeen.has(seen)) return { skipped: 'this bar was already acted on' };
    if (this.patternSeen.size > 500) this.patternSeen.clear();
    this.patternSeen.add(seen);
    const ruled = this.#ruled(settings, read, side);
    const result = await this.#enter(settings, read, { ...ruled, index: read.index ?? DEFAULT_INDEX, trigger: { ...side.trigger, kind: scoreLabel(side) }, pattern: 'score', atr: read.market.atr5 });
    if (/live price/.test(result.skipped ?? '')) this.patternSeen.delete(seen);
    return result;
  }

  /** The chosen stop rule applied to a score entry: unless it is the chart level, the stop is moved to where the rule puts it. */
  #ruled(settings, read, side) {
    const rule = stopRuleOf(settings, read.index);
    const atr = read.atr5 ?? read.market?.atr5;
    if (!rule || rule.mode === 'chart' || !(atr > 0) || !side.stop) return side;
    const d = side.type === 'CE' ? 1 : -1;
    let price = ruleStop({ side: side.type, stop: side.stop.price, atr }, read.spot, rule);
    if (d * (read.spot - price) < MIN_STOP_ATR * atr) price = read.spot - d * MIN_STOP_ATR * atr;
    return { ...side, stop: { ...side.stop, price: roundToTick(price), note: `${side.stop.note}; moved by your stop setting to ${INDEXES[read.index ?? DEFAULT_INDEX].short} ${roundToTick(price)}` } };
  }

  /**
   * Buy when a chosen chart pattern was completed by the 5-minute bar that has just closed. The stop is the pattern's own chart level
   * (never closer than 0.8 ATR; a pattern whose stop is further than 2.5 ATR is skipped), the lots, the hard stop and the profit lock
   * are the same as for every other entry. Each pattern is acted on once.
   */
  async considerPatterns(settings, read) {
    const keys = entryModes(settings).patterns;
    if (!keys.length) return { skipped: 'no chart pattern is switched on' };
    if (!read?.ready) return { skipped: 'the chart is not ready yet' };
    const bars = read.market.done5;
    const last = bars.at(-1);
    if (!last || this.now() - (last.time + 300) * 1000 > PATTERN_FRESH_MS) return { skipped: 'no fresh bar' };
    const hits = findSignals(prepare(bars), { only: keys, from: bars.length - 1, windows: this.config.enforceMarketHours, when: this.config.enforceMarketHours ? entryTest(entryWindowOf(settings)) : null }).sort((a, b) => keys.indexOf(a.technique) - keys.indexOf(b.technique));
    return this.#actOn(settings, read, hits, last, (hit) => LIVE_PATTERNS.find((p) => p.key === hit.technique).label, { minScore: settings.patternMinScore ?? 0 });
  }

  /**
   * Buy when one of the user's own combinations (Account > Entries) became true on the 5-minute bar that has just closed. Handled like a
   * pattern: its own stop level, the same limits and lots, and (with a combination score set) the chart score of its side must reach it.
   * The 50-stock breadth and volume come from the live candles of the scanner.
   */
  async considerCombos(settings, read) {
    const combos = normalizeCombos(settings.combos).filter((c) => c.on && comboFitsIndex(c, read?.index ?? DEFAULT_INDEX));
    if (!combos.length) return { skipped: 'no combination is switched on' };
    if (!read?.ready) return { skipped: 'the chart is not ready yet' };
    const bars = read.market.done5;
    const last = bars.at(-1);
    if (!last || this.now() - (last.time + 300) * 1000 > PATTERN_FRESH_MS) return { skipped: 'no fresh bar' };
    const chart = this.#comboChart(read.index ?? DEFAULT_INDEX, bars);
    // read the last few bars, as the study reads the whole chart, so a combination that fired 1 to 3 bars ago waits out its cooldown here too
    // (live used to look at the newest bar alone and could buy a repeat signal the study never takes); only a signal on the newest bar is acted on
    const newest = bars.length - 1;
    const hits = combos.flatMap((combo) => comboSignals(chart, combo, { from: Math.max(16, bars.length - 6), windows: this.config.enforceMarketHours, when: this.config.enforceMarketHours ? entryTest(entryWindowOf(settings)) : null, label: `combo:${combo.id}` }).filter((h) => h.i === newest).map((hit) => ({ ...hit, combo, comboId: combo.id })));
    const names = new Map(combos.map((c) => [`combo:${c.id}`, c.name]));
    return this.#actOn(settings, read, hits, last, (hit) => `Combination: ${names.get(hit.technique)}`, { minScore: settings.comboMinScore ?? 0 });
  }

  #stocks5() {
    const stocks5 = {};
    for (const symbol of this.scanner?.store?.symbols ?? []) {
      const c = this.scanner.store.get(symbol, '5m');
      if (c?.length) stocks5[symbol] = c;
    }
    return stocks5;
  }

  async #secondSettings() {
    if (Date.now() - this.secondCacheAt < SECOND_CACHE_MS) return;
    this.secondCacheAt = Date.now();
    const all = await OptionSettings.find({ enabled: true, $or: [{ entryClock: { $in: ['1m', '1s'] } }, { exitClock: { $in: ['1s', '5m'] } }] }).lean();
    this.secondUsers = all.filter((s) => s.entryClock === '1m' || s.entryClock === '1s');
    this.exitClocks = new Map(all.filter((s) => s.exitClock === '1s' || s.exitClock === '5m').map((s) => [String(s.user), s.exitClock]));
    for (const s of this.secondUsers) this.secondExit.set(String(s.user), (await loadRules(s.user, 'OPT')).exitMin);
  }

  /**
   * "Buy on the second": every second the combinations are read on the 5-minute bar that is still forming, at the live index price.
   * A signal has to stay true for `secondConfirm` seconds in a row before it buys, and each combination buys once per 5-minute bar
   * (the same bar's close later finds it already acted on). All the usual limits, stops and lots apply, the log says "on the second".
   */
  async secondScan() {
    if (this.secondBusy) return;
    this.secondBusy = true;
    try {
      await this.#secondSettings();
      if (!this.secondUsers.length) return this.holds.prune(new Set());
      if (this.config.enforceMarketHours && !this.engine.marketStatus().isOpen) return;
      const nowSec = Math.floor(this.now().getTime() / 1000);
      const nowMin = istParts(this.now()).minutes;
      const active = new Set();
      for (const s of this.secondUsers) {
        if (this.config.enforceMarketHours && nowMin >= (this.secondExit.get(String(s.user)) ?? 915)) continue;
        if ([...this.open.values()].filter((w) => w.user === String(s.user)).length >= (s.maxOpen ?? 1)) continue;
        for (const index of activeIndexes(s)) {
          const si = forIndex(s, index);
          if (!entryModes(si).combos) continue;
          if (s.entryClock === '1m') {
            if (nowSec % 60 >= 3) continue; // a 1-minute entry is read in the first seconds of each new minute, at the price of the minute mark
            const mk = `${s.user}|${index}`;
            const minute = Math.floor(nowSec / 60);
            if (this.minuteDone.get(mk) === minute) continue;
            this.minuteDone.set(mk, minute);
          }
          const base = this.lastReads.get(index);
          const ltp = this.market.getLtp(INDEXES[index].symbol);
          if (!base?.ready || !base.c1 || !ltp || !followsSlot(base.market.done5, nowSec)) continue; // the chart read of the 15-second scan must reach right up to this 5-minute slot
          const combos = normalizeCombos(si.combos).filter((c) => c.on && comboFitsIndex(c, index));
          if (!combos.length) continue;
          const forming = formingBar(base.c1, ltp, nowSec);
          const bars = [...base.market.done5, forming];
          const stocks5 = this.#stocks5();
          const chart = buildChart(bars, { breadth: breadthSeries(bars, stocks5), flow: turnoverSeries(bars, stocks5), from: Math.max(15, bars.length - 14) });
          const newest = bars.length - 1;
          const names = new Map(combos.map((c) => [`combo:${c.id}`, c.name]));
          const ready = [];
          for (const combo of combos) {
            const hits = comboSignals(chart, combo, { from: Math.max(16, bars.length - 6), windows: this.config.enforceMarketHours, when: this.config.enforceMarketHours ? entryTest(entryWindowOf(si)) : null, label: `combo:${combo.id}` }).filter((h) => h.i === newest);
            for (const hit of hits) {
              const key = `${s.user}|${index}|${hit.technique}|${hit.side}|${forming.time}`;
              active.add(key);
              if (this.holds.held(key, Date.now(), s.entryClock === '1m' ? 0 : s.secondConfirm ?? 3)) ready.push({ ...hit, combo, comboId: combo.id, clock: s.entryClock === '1m' ? 'minute' : 'second' });
            }
          }
          if (!ready.length) continue;
          const live = Object.create(base, { spot: { value: ltp, enumerable: true } }); // the chart read, with the price of this second
          await this.#actOn(si, live, ready, forming, (hit) => `Combination: ${names.get(hit.technique)} (${s.entryClock === '1m' ? 'on the minute' : 'on the second'})`, { minScore: si.comboMinScore ?? 0 });
        }
      }
      this.holds.prune(active);
    } finally {
      this.secondBusy = false;
    }
  }

  /** An index chart with the 50 stocks' breadth and traded value from the scanner's live candles, rebuilt once per 5-minute bar. */
  #comboChart(index, bars) {
    const last = bars.at(-1).time;
    const kept = this.comboCharts.get(index);
    if (kept?.time === last) return kept.chart;
    const stocks5 = this.#stocks5();
    const breadth = breadthSeries(bars, stocks5);
    const flow = turnoverSeries(bars, stocks5);
    const chart = buildChart(bars, { breadth, flow, from: Math.max(15, bars.length - 14) }); // patterns far enough back for the combination window of the bars read below
    this.comboCharts.set(index, { time: last, chart });
    return chart;
  }

  // `minScore`: a pattern is bought only while the chart's score for its side is at least this (0 = no check, the score then only decorates the log)
  async #actOn(settings, read, hits, last, labelOf, { minScore = 0 } = {}) {
    let result = { skipped: 'no pattern' };
    for (const hit of hits) {
      if (settings.sideOnly && hit.side !== settings.sideOnly) continue; // calls only or puts only
      const seen = `${settings.user}|${read.index}|${hit.technique}|${last.time}`;
      if (this.patternSeen.has(seen)) continue;
      if (this.patternSeen.size > 500) this.patternSeen.clear();
      this.patternSeen.add(seen);
      const d = hit.side === 'CE' ? 1 : -1;
      const label = labelOf(hit);
      const spot = read.spot;
      const sideScore = read[hit.side === 'CE' ? 'ce' : 'pe']?.score;
      let stop = ruleStop(hit, spot, hit.stopRule ?? stopRuleOf(settings, read.index));
      if (d * (spot - stop) < MIN_STOP_ATR * hit.atr) stop = spot - d * MIN_STOP_ATR * hit.atr;
      const side = { type: hit.side, index: read.index ?? DEFAULT_INDEX, d, score: sideScore, checks: [], gates: [], blocked: [], levels: [], trigger: { kind: label, level: roundToTick(hit.close) }, stop: { price: roundToTick(stop), note: `${hit.note}; stop at ${INDEXES[read.index ?? DEFAULT_INDEX].short} ${roundToTick(stop)}`, ok: true }, pattern: hit.technique, ...(hit.clock ? { clock: hit.clock } : {}), ...(hit.comboId ? { comboId: hit.comboId } : {}), atr: hit.atr, ...(hit.exits ? { exits: hit.exits } : {}), ...(hit.combo ? { combo: hit.combo } : {}) };
      if (minScore && !(sideScore >= minScore)) {
        result = await this.#skip(settings, side, `${label} ${hit.side}: the chart score ${sideScore == null ? 'is not known' : `is ${Math.round(sideScore)}`}, under the ${minScore} you asked for`);
        continue;
      }
      if (d * (spot - stop) > MAX_STOP_ATR * hit.atr) {
        result = await this.#skip(settings, side, `${label} ${hit.side}: the stop (${INDEXES[read.index ?? DEFAULT_INDEX].short} ${roundToTick(stop)}) is ${round2((d * (spot - stop)) / hit.atr)} ATR away, over the ${MAX_STOP_ATR} limit`);
        continue;
      }
      result = await this.#enter(settings, read, side);
      if (result.order) return result;
      // no price yet for a contract just picked is not a verdict on the signal: try this bar again on the next scan (it is still fresh)
      if (/live price/.test(result.skipped ?? '')) this.patternSeen.delete(seen);
    }
    return result;
  }

  async #enter(settings, read, side, { manual = false, lots = null } = {}) {
    const userId = settings.user;
    const today = await this.todaySummary(userId);
    const stop = (reason) => (manual ? { skipped: reason } : this.#skip(settings, side, reason));
    if (today.open >= settings.maxOpen) return stop(`already ${today.open} option trade${today.open > 1 ? 's' : ''} open`);
    if (!manual) {
      if (settings.pausedOn && settings.pausedOn === this.engine.marketStatus().istDate) return stop('new automatic buys are paused for today (your switch in Options)');
      if (today.trades >= settings.maxTrades) return stop(`already took ${today.trades} option trades today`);
      if (today.pnl <= -(settings.budget * settings.dailyLossPct) / 100) return stop('daily loss limit reached');
      const streak = settings.lossStreak ?? 2;
      if (streak > 0) {
        const lost = await this.lossesInARowToday(userId);
        if (lost >= streak) return stop(`${lost} losing option trades in a row today: no new automatic buy until tomorrow (Account > Limits, "losses in a row")`);
      }
      const wait = await this.#coolingDown(userId, side.type);
      if (wait) return stop(wait);
    }
    const index = side.index ?? DEFAULT_INDEX;
    // one call and one put at a time across both indexes (they move together); with "Take the signal on both indexes" each index may hold its own
    const held = new RegExp(settings.mirror ? `^${index}-.*-${side.type}$` : `-${side.type}$`);
    if (await Position.findOne({ user: userId, segment: 'OPT', status: 'OPEN', symbol: held })) return stop(`already holding a ${side.type}`);

    if (!manual && settings.comboStreak > 0 && side.trigger?.kind) {
      // the losing-streak pause: this entry (pattern or combination) lost comboStreak times in a row today
      const done = await AutoLog.find({ user: userId, segment: 'OPT', day: this.engine.marketStatus().istDate, decision: 'PLACED', status: 'CLOSED', setup: side.trigger.kind }, 'outcome decidedAt').sort({ decidedAt: 1 }).lean();
      const why = streakSkip(done.map((l) => ({ net: l.outcome?.netPnl ?? 0 })), settings.comboStreak);
      if (why) return stop(`${side.trigger.kind}: ${why}`);
    }
    const bias = manual ? null : dayBiasOf(settings);
    if (bias && read.c1) {
      const now = Math.floor(this.now().getTime() / 1000);
      const why = dayBiasSkip(dayStand(read.c1, { now: now - (now % 60), price: read.spot }), bias, { side: side.type, index: INDEXES[index].short });
      if (why) return stop(why);
    }
    let probationLots = null;
    if (!manual && side.comboId && settings.probation !== false) {
      // a new combination proves itself with 1 lot first: its study result is a handful of trades, live is the real test
      const n = await AutoLog.countDocuments({ user: userId, segment: 'OPT', decision: 'PLACED', status: 'CLOSED', $or: [{ 'detail.comboId': side.comboId }, { setup: side.trigger?.kind }] });
      if (n < PROBATION_TRADES) probationLots = 1;
    }
    const moved = manual ? null : movedOf(settings);
    if (moved && read.c1) {
      // the "already moved" check: how far the index has run in this trade's direction before now
      const now = Math.floor(this.now().getTime() / 1000);
      const measures = movedMeasures(read.c1, { price: read.spot, now: now - (now % 60), side: side.type, atr: side.atr ?? read.atr5 });
      const why = movedSkip(measures, moved, { side: side.type, index: INDEXES[index].short });
      if (why) return stop(why);
    }
    const contract = await this.market.pickOption({ type: side.type, now: this.now(), index });
    if (!contract?.ltp) return stop('no option contract with a live price');
    const chase = manual ? null : chaseOf(settings);
    if (chase) {
      // the anti-chase check: the contract's own 1-minute candles of today; with none (or no broker), the check is not made
      const candles = await Promise.resolve(this.market.provider?.getTodayOptionCandles?.(contract.symbol, 1)).catch(() => []);
      const why = chaseSkip(chaseRise(candles ?? [], contract.ltp, { now: Math.floor(this.now().getTime() / 1000), minutes: chase.minutes }), chase);
      if (why) return stop(why);
    }
    const funds = await getFunds(userId, this.config.startingBalance);
    const planned = planTrade({ read: side, market: read.market, contract, premium: contract.ltp, settings, rules: await loadRules(userId, 'OPT', { index }), available: funds.available, spentBudget: today.spent, now: this.now(), lots: probationLots ?? lots });
    if (planned.skipped) return stop(planned.skipped);
    const plan = planned.plan;

    let order;
    try {
      ({ order } = await this.engine.placeOrder(userId, { symbol: plan.symbol, side: 'BUY', orderType: 'MARKET', qty: plan.qty, stopLoss: plan.stopLoss ?? undefined, source: manual ? 'MANUAL' : 'AUTO' }));
    } catch (e) {
      return stop(`order not placed: ${e.message}`);
    }
    if (order.status !== 'FILLED') return stop(order.rejectReason || `order was ${String(order.status).toLowerCase()}`);
    const position = await Position.findOne({ user: userId, symbol: plan.symbol, status: 'OPEN' }, '_id').lean();
    const fill = order.avgFillPrice ?? plan.premium;
    // a combination's own exits replace the shared ones (Account > Limits and Entries) for its trades; a part it leaves out keeps the shared one
    const own = side.exits ?? null;
    const exitTrail = own && 'trail' in own ? own.trail : trailOf(settings);
    const exitBreakEven = own && 'breakEven' in own ? own.breakEven : breakEvenOf(settings);
    if (own && 'steps' in own) {
      try {
        await this.engine.setExits(userId, plan.symbol, { lockSteps: own.steps, lockTrigger: null, lockAmount: null });
      } catch (e) {
        logger.warn(`Own profit ladder not applied to ${plan.symbol}: ${e.message}`);
      }
    }
    this.#watch(userId, plan.symbol, { type: plan.type, index, stopSpot: plan.stopSpot, entry: fill, risk: Math.max(fill - (plan.stopLoss ?? 0), 0.05), openedAt: this.now(), manual, entrySpot: read.spot ?? null, trail: exitTrail, breakEven: exitBreakEven, stopWhy: 'STOP', bestSpot: read.spot ?? null, bestR: 0, worstR: 0 });
    await this.#record(settings, {
      symbol: plan.symbol,
      side: 'BUY',
      setup: side.trigger?.kind,
      score: side.score,
      decision: 'PLACED',
      status: 'OPEN',
      entry: plan.premium,
      stopLoss: plan.stopLoss,
      ltp: contract.ltp,
      qty: order.qty,
      fillPrice: fill,
      order: order._id,
      position: position?._id,
      card: { checks: side.checks, gates: side.gates },
      detail: { ...plan, index, label: optionLabel(plan.symbol), manual, entrySpot: read.spot ?? null, trail: exitTrail, breakEven: exitBreakEven, ...(own ? { ownExits: own } : {}), trigger: side.trigger, pattern: side.pattern ?? null, ...(side.clock ? { clock: side.clock } : {}), firstStopSpot: plan.stopSpot, ...(side.comboId ? { comboId: side.comboId } : {}), ...(probationLots ? { probation: true } : {}), ...(side.combo ? { combo: { id: side.combo.id, name: side.combo.name, conds: side.combo.conds, need: side.combo.need, window: side.combo.window } } : {}), contract: { symbol: plan.symbol, strike: plan.strike, type: plan.type, expiry: plan.expiry, lotSize: plan.lotSize }, snapshot: read.snapshot },
    });
    return { order, plan };
  }

  /** Buy `side` of a chart read now, sized, stopped and limited like every other entry (the manual buy and the tests use this). */
  enterRead(settings, read, side, opts) {
    return this.#enter(settings, read, side, opts);
  }

  /** Buy now by hand, with the same stop and profit lock as the automatic trader. `type` is 'CE' or 'PE'. */
  async enterManually(userId, type, lots = 1, index = DEFAULT_INDEX) {
    const read = await this.read(index);
    if (!read.ready) return { skipped: `the ${INDEXES[index].short} chart is not ready yet` };
    const side = type === 'CE' ? read.ce : read.pe;
    const settings = forIndex({ ...((await OptionSettings.findOne({ user: userId }).lean()) ?? new OptionSettings({ user: userId }).toObject()), user: userId }, index);
    return this.#enter(settings, read, side, { manual: true, lots });
  }

  /** How many of today's closed option trades lost in a row, counted back from the last one. */
  async lossesInARowToday(userId) {
    const closed = await Position.find({ user: userId, segment: 'OPT', status: 'CLOSED', tradingDay: this.engine.marketStatus().istDate }, 'realizedPnl charges closedAt').sort({ closedAt: 1 }).lean();
    return lossesInARow(closed.map((p) => p.realizedPnl - p.charges));
  }

  async #coolingDown(userId, type) {
    const last = await Position.find({ user: userId, segment: 'OPT', status: 'CLOSED', tradingDay: this.engine.marketStatus().istDate }).sort({ closedAt: -1 }).limit(1).lean();
    const p = last[0];
    if (!p?.closedAt) return null;
    const mins = (this.now() - p.closedAt) / 60000;
    const lost = p.realizedPnl - p.charges < 0;
    if (lost && mins < COOLDOWN_AFTER_STOP_MIN) return `cooling off for ${Math.ceil(COOLDOWN_AFTER_STOP_MIN - mins)} more minutes after a losing trade`;
    if (p.symbol.endsWith(`-${type}`) && mins < SAME_SIDE_COOLDOWN_MIN) return `a ${type} was closed ${Math.round(mins)} minutes ago`;
    return null;
  }

  // ---------- watching open trades ----------

  async #exit(userId, symbol, reason) {
    const key = `${userId}|${symbol}`;
    if (this.exiting.has(key)) return;
    this.exiting.add(key);
    this.reasons.set(key, reason);
    try {
      await this.engine.exitPosition(userId, symbol);
    } catch (e) {
      this.reasons.delete(key);
      logger.warn(`options exit of ${symbol} failed: ${e.message}`);
    } finally {
      this.exiting.delete(key);
    }
  }

  #onTick({ symbol, ltp }) {
    const index = indexKeyOf(symbol);
    if (index) {
      this.#trail(index, ltp);
      this.#indexMinute(index, ltp);
      if ([...this.exitClocks.values()].includes('1s')) this.#secondStop(index, ltp);
    }
    if (!this.open.size) return;
    for (const w of this.open.values()) {
      if (symbol === w.symbol && w.risk) {
        const r = (ltp - w.entry) / w.risk;
        w.bestR = Math.max(w.bestR, r);
        w.worstR = Math.min(w.worstR, r);
      }
    }
  }

  /** "Sell on the second": for users with it on, the chart stop sells the moment the index touches it (the 1-minute close rule below stays for everyone else). */
  #secondStop(index, ltp) {
    for (const w of this.open.values()) {
      if (w.index !== index || w.stopOff || w.stopSpot == null || this.exitClocks.get(w.user) !== '1s') continue;
      if (w.type === 'CE' ? ltp <= w.stopSpot : ltp >= w.stopSpot) this.#exit(w.user, w.symbol, w.stopWhy ?? 'STOP').catch(() => {});
    }
  }

  /**
   * The trailing stop (Account > Limits): once the index has moved `start` points your way the chart stop sits `points` behind the best
   * index price, and it never moves back. The sale is still decided on a closed 1-minute candle beyond the (moved) level.
   */
  #trail(index, ltp) {
    for (const w of this.open.values()) {
      if (w.index !== index || w.stopOff) continue;
      if ((!w.trail && !(w.breakEven > 0)) || w.entrySpot == null || w.stopSpot == null) continue;
      const long = w.type === 'CE';
      w.bestSpot = long ? Math.max(w.bestSpot ?? ltp, ltp) : Math.min(w.bestSpot ?? ltp, ltp);
      const gained = long ? w.bestSpot - w.entrySpot : w.entrySpot - w.bestSpot;
      const better = (level) => (long ? level > w.stopSpot : level < w.stopSpot);
      if (w.breakEven > 0 && gained >= w.breakEven && better(w.entrySpot)) {
        w.stopSpot = roundToTick(w.entrySpot);
        w.stopWhy = 'BREAKEVEN';
        w.moved = true;
      }
      if (w.trail && gained >= w.trail.start) {
        const level = roundToTick(long ? w.bestSpot - w.trail.points : w.bestSpot + w.trail.points);
        if (better(level)) {
          w.stopSpot = level;
          w.stopWhy = 'TRAIL';
          w.moved = true;
        }
      }
    }
  }

  /**
   * The chart says the idea is wrong when a 1-minute candle of the index CLOSES beyond the stop level, even if the premium has not
   * fallen that far yet. One tick through the level (a wick) does not count: that is how a good trade gets shaken out. The hard premium
   * stop in the order engine stays as the backup for a fast move.
   */
  #indexMinute(index, ltp) {
    const minute = Math.floor(this.now().getTime() / 60000);
    const bar = this.bars.get(index);
    if (bar && bar.minute !== minute) {
      const close = bar.last;
      for (const w of this.open.values()) {
        if (w.index !== index) continue;
        if (w.stopOff) continue; // stop switched off by hand: only the floor and profit lock in the order engine can sell it
        if (this.exitClocks.get(w.user) === '5m') continue; // this user's stop reads the 5-minute close instead (below)
        if (w.stopSpot != null && (w.type === 'CE' ? close <= w.stopSpot : close >= w.stopSpot)) this.#exit(w.user, w.symbol, w.stopWhy ?? 'STOP').catch(() => {});
        else if (w.moved) {
          // the trailed level is written to the log once a minute, so a restart keeps it
          w.moved = false;
          AutoLog.updateOne({ user: w.user, segment: 'OPT', symbol: w.symbol, status: 'OPEN' }, { $set: { 'detail.stopSpot': w.stopSpot, 'detail.bestSpot': w.bestSpot, 'detail.stopWhy': w.stopWhy } }).catch(() => {});
        }
      }
    }
    this.bars.set(index, { minute, last: ltp });
    const slot = Math.floor(this.now().getTime() / 300000);
    const bar5 = this.bars5.get(index);
    if (bar5 && bar5.slot !== slot) {
      for (const w of this.open.values()) {
        if (w.index !== index || w.stopOff || this.exitClocks.get(w.user) !== '5m') continue;
        if (w.stopSpot != null && (w.type === 'CE' ? bar5.last <= w.stopSpot : bar5.last >= w.stopSpot)) this.#exit(w.user, w.symbol, w.stopWhy ?? 'STOP').catch(() => {});
      }
    }
    this.bars5.set(index, { slot, last: ltp });
  }

  /**
   * The time close for the auto trader's open option trades: the exit time set in the Account tab, 15:15 unless you changed it.
   * A trade you bought by hand is never closed by it: it keeps its stop and lock, and the 15:15 square-off is the only time limit.
   */
  async manage(userId) {
    const { minutes } = istParts(this.now());
    const mine = [...this.open.values()].filter((x) => x.user === String(userId) && !x.manual);
    if (!mine.length) return;
    const { exitMin } = await loadRules(userId, 'OPT');
    for (const w of mine) {
      if (minutes >= exitMin) await this.#exit(w.user, w.symbol, 'TIME');
    }
  }

  /** A stop, target, exit or square-off filled: if that closed an option trade, record how it ended. */
  async #finish({ userId, order }) {
    const log = await AutoLog.findOne({ user: userId, segment: 'OPT', symbol: order.symbol, status: 'OPEN' });
    if (!log) return;
    const pos = await Position.findById(log.position).lean();
    if (!pos || pos.status !== 'CLOSED') return;
    const key = `${userId}|${order.symbol}`;
    const w = this.open.get(key);
    this.open.delete(key);
    const why = this.reasons.get(key);
    this.reasons.delete(key);
    const gross = pos.realizedPnl;
    const exitReason = order.role === 'TARGET' ? 'TARGET' : order.role === 'STOPLOSS' ? (gross > 0 ? 'LOCK' : pos.stopOff ? 'FLOOR' : 'STOP') : order.role === 'SQUAREOFF' ? 'SQUARE_OFF' : why || 'MANUAL';
    const risk = Math.abs((log.fillPrice ?? log.entry) - log.stopLoss);
    const exitPrice = order.avgFillPrice;
    const outcome = {
      exitReason,
      exitPrice,
      grossPnl: round2(gross),
      charges: round2(pos.charges),
      netPnl: round2(gross - pos.charges),
      resultR: risk ? round2((exitPrice - (log.fillPrice ?? log.entry)) / risk) : null,
      minutesHeld: Math.round(((pos.closedAt || new Date()) - pos.openedAt) / 60000),
      bestR: w ? round2(w.bestR) : null,
      worstR: w ? round2(w.worstR) : null,
      closedAt: pos.closedAt,
    };
    await AutoLog.updateOne({ _id: log._id, status: 'OPEN' }, { status: 'CLOSED', outcome });
    if (outcome.netPnl < 0 && !log.detail?.manual && log.detail?.comboId) await this.benchIfCold(userId, log.detail.comboId).catch((e) => logger.warn(`bench check failed: ${e.message}`));
  }

  /**
   * The bench (Account > Limits): when a combination's last `benchAfter` live trades all lost, it is switched off by itself and keeps its
   * place under My combinations with the day it was benched, so a combination that stopped working does not keep losing unwatched.
   */
  async benchIfCold(userId, comboId) {
    const settings = await OptionSettings.findOne({ user: userId });
    const n = settings?.benchAfter ?? 3;
    if (!settings || !(n > 0)) return null;
    const last = await AutoLog.find({ user: userId, segment: 'OPT', decision: 'PLACED', status: 'CLOSED', 'detail.comboId': comboId }, 'outcome.netPnl').sort({ decidedAt: -1 }).limit(n).lean();
    if (last.length < n || last.some((e) => !(e.outcome?.netPnl < 0))) return null;
    const list = normalizeCombos(settings.combos);
    const combo = list.find((c) => c.id === comboId);
    if (!combo || !combo.on) return null;
    combo.on = false;
    combo.benchedOn = this.engine.marketStatus().istDate;
    settings.combos = list;
    await settings.save();
    logger.info(`combination ${combo.name} benched after ${n} losses in a row`);
    return combo;
  }
}
