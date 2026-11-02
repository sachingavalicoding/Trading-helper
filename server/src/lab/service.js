import { OptionSettings } from '../models/index.js';
import { normalizeCombos } from '../combos/combos.js';
import { loadRules } from '../models/TradeDefaults.js';
import { NIFTY50 } from '../market/instruments.js';
import { INDEXES, lotSizeOf } from '../options/symbols.js';
import { stopRuleOf } from '../study/patterns.js';
import { forIndex } from '../options/indexSettings.js';
import { entryWindowOf } from '../options/signal.js';
import { breakEvenOf, trailOf } from '../study/simulate.js';
import { PriceBook } from '../study/priceBook.js';
import { badRequest } from '../utils/errors.js';
import { analyzeLab, lines, presentLab } from './lab.js';

const WARMUP_DAYS = 6;
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
        entryFrom: entryWindowOf(settings).from,
        entryTo: entryWindowOf(settings).to,
      },
    };
  }

  /** What can be picked as the starting point. */
  async choices(userId, index = 'NIFTY') {
    const { params } = await this.#params(userId, index);
    return lines(params.combos);
  }

  /**
   * @param prices 'mixed' (real premiums on the days they were saved, the model's estimate on the others), 'real' (only the saved days) or 'estimated'
   */
  async run(userId, { base, add = [], from = null, to = null, days = 22, index = 'NIFTY', prices = 'mixed' }) {
    const calendar = (from ? Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1 : Math.ceil((days * 7) / 5)) + WARMUP_DAYS;
    const [{ nifty1, stocks5 }, { params }] = await Promise.all([this.#data(index, calendar), this.#params(userId, index)]);
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
    return { index, mode, savedDays: params.prices ? params.prices.days.length : 0, ...out };
  }
}
