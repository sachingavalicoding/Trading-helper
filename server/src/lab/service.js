import { AutoSettings, OptionSettings } from '../models/index.js';
import { normalizeCombos } from '../combos/combos.js';
import { loadRules } from '../models/TradeDefaults.js';
import { NIFTY50 } from '../market/instruments.js';
import { INDEXES, lotSizeOf } from '../options/symbols.js';
import { stopRuleOf } from '../study/patterns.js';
import { forIndex } from '../options/indexSettings.js';
import { entryWindowOf } from '../options/signal.js';
import { breakEvenOf, trailOf } from '../study/simulate.js';
import { PriceBook } from '../study/priceBook.js';
import { chaseOf } from '../options/chase.js';
import { movedOf } from '../options/moved.js';
import { dayBiasOf } from '../options/dayBias.js';
import { badRequest } from '../utils/errors.js';
import { analyzeLab, lines, presentLab } from './lab.js';
import { analyzeSharesLab, presentSharesLab, shareLines, sharesDayBars } from './sharesLab.js';
import { getFunds } from '../services/walletService.js';
import { withOrderOptions } from './orders.js';

const WARMUP_DAYS = 6;
const orderPart = (c) => ({ side: c.side ?? null, stopMode: c.stopMode ?? null, stopAtr: c.stopMode ? c.stopAtr : null, stopPoints: c.stopMode ? c.stopPoints : null, exits: c.exits ?? null });
const CACHE_MS = 10 * 60_000;

/** Runs the Combination Lab on the saved candles. The candles are kept for ten minutes, so trying one check after another is quick. */
export class LabService {
  constructor({ market, config }) {
    this.market = market;
    this.config = config;
    this.cache = new Map(); // `${index}|${calendar}` -> { at, value }
    this.books = new Map(); // index -> { at, book }: the saved option premiums, read once and kept for a few minutes
    this.analyses = new Map(); // the ranking of every check for one start, so picking checks does not redo it
  }

  async #data(index, calendar) {
    const key = `${index}|${calendar}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const range = (symbol, unit) => (typeof this.market.getStudyRange === 'function' ? this.market.getStudyRange(symbol, unit, calendar) : this.market.getRange(symbol, unit, calendar));
    const nifty1 = await range(INDEXES[index].symbol, 1);
    if (nifty1.length < 400) throw badRequest(`Not enough ${INDEXES[index].short} history is saved. Log in to Upstox and press Download in Research > Saved data.`, 'NO_DATA');
    const stocks5 = {};
    for (let i = 0; i < NIFTY50.length; i += 10) {
      await Promise.all(NIFTY50.slice(i, i + 10).map(async ({ symbol }) => { try { stocks5[symbol] = await range(symbol, 5); } catch { /* that stock is simply left out */ } }));
    }
    const value = { nifty1, stocks5: Object.keys(stocks5).length ? stocks5 : null };
    this.cache.set(key, { at: Date.now(), value });
    for (const [k, v] of this.cache) if (Date.now() - v.at >= CACHE_MS) this.cache.delete(k);
    return value;
  }

  async #book(index) {
    const hit = this.books.get(index);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.book;
    const book = await PriceBook.load(index);
    this.books.set(index, { at: Date.now(), book });
    return book;
  }

  async #params(userId, index) {
    const [rules, settings] = await Promise.all([loadRules(userId, 'OPT', { index }), OptionSettings.findOne({ user: userId }).lean().then((s) => forIndex(s, index))]);
    return {
      params: {
        iv: 0.14,
        index,
        lockStart: rules.lockStart || 1000,
        lockGap: rules.lockGap || 250,
        steps: rules.steps,
        lotSize: lotSizeOf(index, this.config),
        holidays: this.config?.nseHolidays ?? [],
        expiryWeekday: this.market.weekdayOf?.(index) ?? this.market.expiryWeekday,
        strikeStep: INDEXES[index].strikeStep,
        combos: normalizeCombos(settings?.combos),
        stopRule: stopRuleOf(settings, index),
        trail: trailOf(settings),
        breakEven: breakEvenOf(settings),
        lossLimit: rules.stopLoss ?? 0,
        maxLots: settings?.maxLots ?? 2,
        sideOnly: settings?.sideOnly ?? null,
        target: 0,
        fixedLots: 0,
        exitMin: rules.exitMin,
        // the live trader's own rules, so the Lab's day-by-day history is what live would really have done: one call and one put at a time,
        // the pauses after a loss and after the same side, your trades a day, the daily loss limit, the anti-chase, already-moved and with-the-day checks
        live: true,
        maxTrades: settings?.maxTrades ?? 3,
        dailyLoss: settings ? ((settings.budget ?? 0) * (settings.dailyLossPct ?? 0)) / 100 : 0,
        chase: chaseOf(settings),
        moved: movedOf(settings),
        withDay: dayBiasOf(settings),
        comboStreak: settings?.comboStreak ?? 0,
        entryFrom: entryWindowOf(settings).from,
        entryTo: entryWindowOf(settings).to,
      },
    };
  }

  /** The Nifty and the 50 stocks as 1-minute candles, for the shares Lab. Kept ten minutes like the options data. */
  async #shareData(calendar) {
    const key = `SHARES|${calendar}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const range = (symbol, unit) => (typeof this.market.getStudyRange === 'function' ? this.market.getStudyRange(symbol, unit, calendar) : this.market.getRange(symbol, unit, calendar));
    const nifty1 = await range(INDEXES.NIFTY.symbol, 1);
    if (nifty1.length < 400) throw badRequest('Not enough Nifty history is saved. Log in to Upstox and press Download in Research > Saved data.', 'NO_DATA');
    const history = {};
    for (let i = 0; i < NIFTY50.length; i += 10) {
      await Promise.all(NIFTY50.slice(i, i + 10).map(async ({ symbol }) => { try { history[symbol] = await range(symbol, 1); } catch { /* that stock is simply left out */ } }));
    }
    const value = { nifty1, history };
    this.cache.set(key, { at: Date.now(), value });
    for (const [k, v] of this.cache) if (Date.now() - v.at >= CACHE_MS) this.cache.delete(k);
    this.lastShares = value;
    return value;
  }

  async #shareParams(userId) {
    const [rules, auto, funds] = await Promise.all([loadRules(userId, 'EQ'), AutoSettings.findOne({ user: userId }).lean(), getFunds(userId, this.config?.startingBalance ?? 1_000_000).catch(() => null)]);
    const maxOpen = auto?.maxOpen ?? 2;
    const dailyLossPct = auto?.dailyLossPct ?? 2;
    return {
      combos: normalizeCombos(auto?.combos),
      riskAmount: rules.stopLoss || 200,
      steps: rules.steps,
      target: 0,
      exitMin: rules.exitMin,
      slippagePct: 0.05,
      maxAmount: auto?.maxTradeAmount ?? 30000,
      maxShares: auto?.maxShares ?? 0,
      maxOpen,
      dailyLoss: funds?.balance ? (funds.balance * dailyLossPct) / 100 : 0,
    };
  }

  /** What can be picked as the starting point for shares. */
  async shareChoices(userId) {
    const params = await this.#shareParams(userId);
    return shareLines(params.combos);
  }

  /** The shares Lab: one share combination (or check) over the 50 stocks, with `edit` order settings tried in place of the saved ones. */
  async runShares(userId, { base, add = [], from = null, to = null, days = 22, edit = null }) {
    const calendar = (from ? Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1 : Math.ceil((days * 7) / 5)) + WARMUP_DAYS;
    const [{ nifty1, history }, params] = await Promise.all([this.#shareData(calendar), this.#shareParams(userId)]);
    const key = `SHARES|${calendar}|${base}|${from}|${to}|${days}|${JSON.stringify(edit)}|${JSON.stringify(params)}|${nifty1.length}`;
    let hit = this.analyses.get(key);
    if (!hit || Date.now() - hit.at >= CACHE_MS) {
      hit = { at: Date.now(), ctx: analyzeSharesLab({ nifty1, history, params, base, from, to, days, edit }) };
      this.analyses.set(key, hit);
      for (const [k, v] of this.analyses) if (Date.now() - v.at >= CACHE_MS) this.analyses.delete(k);
    }
    return presentSharesLab(hit.ctx, add);
  }

  /** 5-minute bars of one stock around one day, from the candles the last shares run read. */
  shareBars(symbol, day) {
    return sharesDayBars(this.lastShares?.history, symbol, day);
  }

  /** What can be picked as the starting point. */
  async choices(userId, index = 'NIFTY') {
    const { params } = await this.#params(userId, index);
    return lines(params.combos);
  }

  /**
   * @param prices 'mixed' (real premiums on the days they were saved, the model's estimate on the others), 'real' (only the saved days) or 'estimated'
   */
  async run(userId, { base, add = [], from = null, to = null, days = 22, index = 'NIFTY', prices = 'mixed', noStop = null, edit = null }) {
    const calendar = (from ? Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1 : Math.ceil((days * 7) / 5)) + WARMUP_DAYS;
    const [{ nifty1, stocks5 }, { params }] = await Promise.all([this.#data(index, calendar), this.#params(userId, index)]);
    if (noStop) params.noStop = noStop;
    // order settings tried on this one combination in place of its saved ones (side, stop, profit ladder, trail, break-even)
    let edited = false;
    if (edit && String(base).startsWith('combo:')) {
      const id = String(base).slice(6);
      params.combos = params.combos.map((c) => (c.id === id ? withOrderOptions(c, edit) : c));
      const was = (await this.#params(userId, index)).params.combos.find((c) => c.id === id);
      const now = params.combos.find((c) => c.id === id);
      edited = Boolean(was && now) && JSON.stringify(orderPart(was)) !== JSON.stringify(orderPart(now));
    }
    let mode = 'estimated';
    if (prices !== 'estimated') {
      const book = await this.#book(index);
      if (book.days.length) {
        params.prices = book;
        params.mixPrices = prices === 'mixed';
        mode = prices;
      }
    }
    const key = `${index}|${calendar}|${base}|${from}|${to}|${days}|${mode}|${JSON.stringify({ ...params, prices: params.prices?.days.length ?? 0 })}|${nifty1.length}`;
    let hit = this.analyses.get(key);
    if (!hit || Date.now() - hit.at >= CACHE_MS) {
      hit = { at: Date.now(), ctx: analyzeLab({ nifty1, stocks5, params, base, from, to, days }) };
      this.analyses.set(key, hit);
      for (const [k, v] of this.analyses) if (Date.now() - v.at >= CACHE_MS) this.analyses.delete(k);
    }
    const out = presentLab(hit.ctx, add);
    const combo = String(base).startsWith('combo:') ? params.combos.find((c) => c.id === String(base).slice(6)) : null;
    return { index, mode, savedDays: params.prices ? params.prices.days.length : 0, ...out, segment: 'options', orders: combo ? { ...orderPart(combo), used: { lossLimit: params.lossLimit, steps: params.steps, maxLots: params.maxLots }, edited } : null };
  }
}
