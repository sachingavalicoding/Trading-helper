import { AutoLog, OptionSettings, Order, Position, Trade } from '../models/index.js';
import { getFunds } from '../services/walletService.js';
import { INDEXES, DEFAULT_INDEX, INDEX_KEYS, indexKeyOf, isOptionSymbol, optionLabel, parseOptionSymbol } from './symbols.js';
import { readNifty } from './signal.js';
import { breakEvenOf, trailOf } from '../study/simulate.js';
import { TECHNIQUES, prepare, findSignals, turnoverSeries, ruleStop, stopRuleOf, MIN_STOP_ATR, MAX_STOP_ATR } from '../study/patterns.js';
import { breadthSeries } from '../study/optionsStudy.js';
import { buildChart } from '../combos/conditions.js';
import { comboSignals, normalizeCombos } from '../combos/combos.js';
import { roundToTick } from '../utils/money.js';
import { planTrade } from './plan.js';
import { loadRules } from '../models/TradeDefaults.js';
import { istParts } from '../market/marketHours.js';
import { logger } from '../utils/logger.js';

const round2 = (n) => Math.round(n * 100) / 100;

const SCAN_MS = 15000;
const COOLDOWN_AFTER_STOP_MIN = 20;
const SAME_SIDE_COOLDOWN_MIN = 15;
const LOG_REPEAT_MS = 30 * 60000; // the same skip reason is written to the log at most this often
const PATTERN_FRESH_MS = 4 * 60000; // a pattern is acted on only while the 5-minute bar that completed it closed under 4 minutes ago

// The chart patterns the trader can buy on. The 30-day study (Options > Study) found these three made money on more than 12 trades each:
// breakout of the last hour (+13.4k, 76% win), inside bar breakout (+6.4k) and the EMA 9/21 cross (+2.5k). The 50-stock breadth needs history the live feed lacks.
export const LIVE_PATTERNS = TECHNIQUES.filter((t) => t.key !== 'breadth' && !t.needs).map((t) => ({ key: t.key, label: t.label }));
export const DEFAULT_PATTERNS = ['breakout', 'insideBar', 'emaCross'];

/** Which entry sources are on for a user: the chosen chart patterns and the user's own combinations. (The all-checks score no longer buys.) */
export function entryModes(settings) {
  const known = new Set(LIVE_PATTERNS.map((p) => p.key));
  const chosen = (settings.patterns ?? DEFAULT_PATTERNS).filter((k) => known.has(k));
  return { patterns: settings.patternEntries === false ? [] : chosen, combos: settings.comboEntries !== false && normalizeCombos(settings.combos).some((c) => c.on) };
}

/** The indexes a user trades: those ticked in the settings (Nifty only when nothing was ever saved). */
export function activeIndexes(settings) {
  const chosen = (settings.indexes ?? []).filter((k) => INDEX_KEYS.includes(k));
  return chosen.length ? INDEX_KEYS.filter((k) => chosen.includes(k)) : [DEFAULT_INDEX];
}

/**
 * Paper options trader for Nifty 50 and Sensex index options. Every 15 seconds it reads the chart of each index the user trades; when a chart
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
    this.onTick = (t) => this.#onTick(t);
    this.onUpdate = (u) => {
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
  }

  stop() {
    clearInterval(this.timer);
    this.market.off('tick', this.onTick);
    this.engine.off('update', this.onUpdate);
  }

  #watch(userId, symbol, info) {
    this.open.set(`${userId}|${symbol}`, { user: String(userId), symbol, ...info });
  }

  /** What one lot (or the lots the settings allow) of each side would be, shown before you buy: the same plan the trader would place. */
  async preview(userId, read, contracts) {
    const settings = (await OptionSettings.findOne({ user: userId }).lean()) || new OptionSettings({ user: userId }).toObject();
    const [today, funds, rules] = await Promise.all([this.todaySummary(userId), getFunds(userId, this.config.startingBalance), loadRules(userId, 'OPT')]);
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

  /** The chart read of one index ('NIFTY' or 'SENSEX'), both sides, as of now. */
  async read(index = DEFAULT_INDEX) {
    const symbol = INDEXES[index].symbol;
    const [c1, daily] = await Promise.all([this.market.getCandles(symbol, '1m'), this.market.getDaily(symbol).catch(() => [])]);
    const read = readNifty(
      { c1, daily, tick: this.market.getTick(symbol), breadthUp: this.scanner?.marketState?.breadthUp ?? null },
      { now: this.now(), enforceWindows: this.config.enforceMarketHours },
    );
    if (read.ready) {
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
          const modes = entryModes(s);
          for (const index of activeIndexes(s)) {
            const read = await readOf(index);
            if (modes.patterns.length) {
              const p = await this.considerPatterns(s, read);
              if (p.order) continue;
            }
            if (modes.combos) await this.considerCombos(s, read);
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
    const hits = findSignals(prepare(bars), { only: keys, from: bars.length - 1, windows: this.config.enforceMarketHours }).sort((a, b) => keys.indexOf(a.technique) - keys.indexOf(b.technique));
    return this.#actOn(settings, read, hits, last, (hit) => LIVE_PATTERNS.find((p) => p.key === hit.technique).label, { minScore: settings.patternMinScore ?? 0 });
  }

  /**
   * Buy when one of the user's own combinations (Account > Entries) became true on the 5-minute bar that has just closed. Handled like a
   * pattern: its own stop level, the same limits and lots. The 50-stock breadth and volume come from the live candles of the scanner.
   */
  async considerCombos(settings, read) {
    const combos = normalizeCombos(settings.combos).filter((c) => c.on);
    if (!combos.length) return { skipped: 'no combination is switched on' };
    if (!read?.ready) return { skipped: 'the chart is not ready yet' };
    const bars = read.market.done5;
    const last = bars.at(-1);
    if (!last || this.now() - (last.time + 300) * 1000 > PATTERN_FRESH_MS) return { skipped: 'no fresh bar' };
    const chart = this.#comboChart(read.index ?? DEFAULT_INDEX, bars);
    const hits = combos.flatMap((combo) => comboSignals(chart, combo, { from: bars.length - 1, windows: this.config.enforceMarketHours, label: `combo:${combo.id}` }));
    const names = new Map(combos.map((c) => [`combo:${c.id}`, c.name]));
    return this.#actOn(settings, read, hits, last, (hit) => `Combination: ${names.get(hit.technique)}`);
  }

  /** An index chart with the 50 stocks' breadth and traded value from the scanner's live candles, rebuilt once per 5-minute bar. */
  #comboChart(index, bars) {
    const last = bars.at(-1).time;
    const kept = this.comboCharts.get(index);
    if (kept?.time === last) return kept.chart;
    const stocks5 = {};
    for (const symbol of this.scanner?.store?.symbols ?? []) {
      const c = this.scanner.store.get(symbol, '5m');
      if (c?.length) stocks5[symbol] = c;
    }
    const breadth = breadthSeries(bars, stocks5);
    const flow = turnoverSeries(bars, stocks5);
    const chart = buildChart(bars, { breadth, flow, from: Math.max(15, bars.length - 8) });
    this.comboCharts.set(index, { time: last, chart });
    return chart;
  }

  // `minScore`: a pattern is bought only while the chart's score for its side is at least this (0 = no check, the score then only decorates the log)
  async #actOn(settings, read, hits, last, labelOf, { minScore = 0 } = {}) {
    let result = { skipped: 'no pattern' };
    for (const hit of hits) {
      const seen = `${settings.user}|${read.index}|${hit.technique}|${last.time}`;
      if (this.patternSeen.has(seen)) continue;
      if (this.patternSeen.size > 500) this.patternSeen.clear();
      this.patternSeen.add(seen);
      const d = hit.side === 'CE' ? 1 : -1;
      const label = labelOf(hit);
      const spot = read.spot;
      const sideScore = read[hit.side === 'CE' ? 'ce' : 'pe']?.score;
      let stop = ruleStop(hit, spot, stopRuleOf(settings));
      if (d * (spot - stop) < MIN_STOP_ATR * hit.atr) stop = spot - d * MIN_STOP_ATR * hit.atr;
      const side = { type: hit.side, index: read.index ?? DEFAULT_INDEX, d, score: sideScore, checks: [], gates: [], blocked: [], levels: [], trigger: { kind: label, level: roundToTick(hit.close) }, stop: { price: roundToTick(stop), note: `${hit.note}; stop at ${INDEXES[read.index ?? DEFAULT_INDEX].short} ${roundToTick(stop)}`, ok: true }, pattern: hit.technique };
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
      if (today.trades >= settings.maxTrades) return stop(`already took ${today.trades} option trades today`);
      if (today.pnl <= -(settings.budget * settings.dailyLossPct) / 100) return stop('daily loss limit reached');
      const wait = await this.#coolingDown(userId, side.type);
      if (wait) return stop(wait);
    }
    const index = side.index ?? DEFAULT_INDEX;
    // one call and one put at a time across both indexes (they move together); with "Take the signal on both indexes" each index may hold its own
    const held = new RegExp(settings.mirror ? `^${index}-.*-${side.type}$` : `-${side.type}$`);
    if (await Position.findOne({ user: userId, segment: 'OPT', status: 'OPEN', symbol: held })) return stop(`already holding a ${side.type}`);

    const contract = await this.market.pickOption({ type: side.type, now: this.now(), index });
    if (!contract?.ltp) return stop('no option contract with a live price');
    const funds = await getFunds(userId, this.config.startingBalance);
    const planned = planTrade({ read: side, market: read.market, contract, premium: contract.ltp, settings, rules: await loadRules(userId, 'OPT'), available: funds.available, spentBudget: today.spent, now: this.now(), lots });
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
    this.#watch(userId, plan.symbol, { type: plan.type, index, stopSpot: plan.stopSpot, entry: fill, risk: Math.max(fill - (plan.stopLoss ?? 0), 0.05), openedAt: this.now(), manual, entrySpot: read.spot ?? null, trail: trailOf(settings), breakEven: breakEvenOf(settings), stopWhy: 'STOP', bestSpot: read.spot ?? null, bestR: 0, worstR: 0 });
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
      detail: { ...plan, index, label: optionLabel(plan.symbol), manual, entrySpot: read.spot ?? null, trail: trailOf(settings), breakEven: breakEvenOf(settings), trigger: side.trigger, contract: { symbol: plan.symbol, strike: plan.strike, type: plan.type, expiry: plan.expiry, lotSize: plan.lotSize }, snapshot: read.snapshot },
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
    const settings = { ...((await OptionSettings.findOne({ user: userId }).lean()) ?? new OptionSettings({ user: userId }).toObject()), user: userId };
    return this.#enter(settings, read, side, { manual: true, lots });
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

  /**
   * The trailing stop (Account > Limits): once the index has moved `start` points your way the chart stop sits `points` behind the best
   * index price, and it never moves back. The sale is still decided on a closed 1-minute candle beyond the (moved) level.
   */
  #trail(index, ltp) {
    for (const w of this.open.values()) {
      if (w.index !== index) continue;
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
        if (w.stopSpot != null && (w.type === 'CE' ? close <= w.stopSpot : close >= w.stopSpot)) this.#exit(w.user, w.symbol, w.stopWhy ?? 'STOP').catch(() => {});
        else if (w.moved) {
          // the trailed level is written to the log once a minute, so a restart keeps it
          w.moved = false;
          AutoLog.updateOne({ user: w.user, segment: 'OPT', symbol: w.symbol, status: 'OPEN' }, { $set: { 'detail.stopSpot': w.stopSpot, 'detail.bestSpot': w.bestSpot, 'detail.stopWhy': w.stopWhy } }).catch(() => {});
        }
      }
    }
    this.bars.set(index, { minute, last: ltp });
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
    const exitReason = order.role === 'TARGET' ? 'TARGET' : order.role === 'STOPLOSS' ? (gross > 0 ? 'LOCK' : 'STOP') : order.role === 'SQUAREOFF' ? 'SQUARE_OFF' : why || 'MANUAL';
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
  }
}
