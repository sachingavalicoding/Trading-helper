import { BaseProvider, aggregateCandles } from '../market/providers/BaseProvider.js';
import { INDICES } from '../market/instruments.js';
import { isOptionSymbol, parseOptionSymbol } from '../options/symbols.js';
import { istParts } from '../market/marketHours.js';
import { addDays } from '../market/days.js';
import { logger } from '../utils/logger.js';

// Plays one saved day back as if it were live. By default everything (the Nifty index, the option contracts and the shares) comes from the
// saved 1-minute candles, so every saved day plays the same way. With `useSeconds`, the Nifty and the option contracts that were recorded
// each second play those seconds instead (only the newest few days have them). A candle plays as four prices: its open, then its low and
// high (the low first when it closed up, the high first when it closed down: the way that hits a stop before a target), then its close. A price is handed out only when the virtual clock reaches
// its second, and candle history is cut at the clock, so nothing from the "future" is ever visible.
//
// `source` supplies the data (see mongoSource.js): tickSymbols(), readTicks(symbol), readDayCandles(symbol), readPrior(symbol, fromDay).

const PRIOR_DAYS = 12; // calendar days of earlier candles kept for charts and indicators
const isIndexSymbol = (s) => INDICES.some((i) => i.symbol === s);

/**
 * The prices a 1-minute candle plays as: open at its first second, then low and high, then close at its last second. A candle that closed up
 * goes to its low first, one that closed down to its high first, so a stop is reached before a target (the careful guess, never the rosy one).
 */
export function candlePath(c) {
  const row = (time, ltp, volume = 0) => ({ time, ltp, volume, candle: c, bids: [], asks: [], totalBuyQty: 0, totalSellQty: 0 });
  const [first, second] = c.close >= c.open ? [c.low, c.high] : [c.high, c.low];
  return [row(c.time, c.open), row(c.time + 20, first), row(c.time + 40, second), row(c.time + 59, c.close, c.volume)];
}

export class ReplayProvider extends BaseProvider {
  constructor({ source, clock, day, lotSize = 65, pollMs = 200, useSeconds = true }) {
    super();
    this.useSeconds = useSeconds;
    this.source = source;
    this.clock = clock;
    this.day = day;
    this.lotSize = lotSize;
    this.pollMs = pollMs;
    this.states = new Map(); // symbol -> playback state of a subscribed symbol
    this.loading = new Map();
    this.timer = null;
    this.tickSymbols = null; // symbols with recorded seconds
    this.candleOptions = new Set(); // option contracts with saved 1-minute candles of the day (priced once a minute)
    this.spans = new Map(); // option contract -> { first, last, kind }: the seconds (epoch) its prices cover, so only a contract that has a price now can be picked
    this.loadErrors = []; // symbols whose data could not be read, shown in the "Why no trades" panel
  }

  get name() {
    return 'replay';
  }

  get isSimulated() {
    return false; // the prices are real, recorded ones
  }

  get uncached() {
    return true; // candle calls must follow the virtual clock, not a cache
  }

  get capabilities() {
    return { depth: true, history: true, giftNifty: false };
  }

  replayInfo() {
    return { day: this.day, ...this.clock.info() };
  }

  async connect() {
    this.tickSymbols = new Set(this.useSeconds ? await this.source.tickSymbols() : []);
    this.candleOptions = new Set((await this.source.optionCandleSymbols?.()) ?? []);
    for (const [symbol, span] of (await this.source.optionSpans?.()) ?? []) this.spans.set(symbol, { ...span, kind: 'candles' });
    if (this.useSeconds) for (const [symbol, span] of (await this.source.tickSpans?.()) ?? []) this.spans.set(symbol, { ...span, kind: 'ticks' }); // seconds win over candles
    this.timer = setInterval(() => this.#advance(), this.pollMs);
    this.timer.unref?.();
    this.setStatus(true, `Replay of ${this.day}`);
  }

  async disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.setStatus(false, 'Replay stopped');
  }

  async subscribe(symbols) {
    await Promise.all(symbols.map((s) => this.#load(s)));
    this.#advance();
  }

  #load(symbol) {
    if (this.states.has(symbol)) return Promise.resolve();
    if (!this.loading.has(symbol)) {
      this.loading.set(
        symbol,
        this.#build(symbol)
          .then((st) => this.states.set(symbol, st))
          .catch((err) => {
            this.loadErrors.push(`${symbol}: ${err.message}`);
            logger.warn(`Replay could not read ${symbol}: ${err.message}`);
            this.states.set(symbol, this.#empty(symbol));
          })
          .finally(() => this.loading.delete(symbol)),
      );
    }
    return this.loading.get(symbol);
  }

  #empty(symbol) {
    return { symbol, rows: [], cursor: 0, candles: [], prior: [], prevClose: null, open: null, high: null, low: null, last: null, kind: 'none' };
  }

  async #build(symbol) {
    const fromDay = addDays(this.day, -PRIOR_DAYS);
    const prior = isOptionSymbol(symbol) ? [] : await this.source.readPrior(symbol, fromDay);
    const prevClose = prior.at(-1)?.close ?? null;
    if (this.tickSymbols.has(symbol)) {
      const rows = (await this.source.readTicks(symbol)).filter((r) => r.ltp > 0);
      return { ...this.#empty(symbol), kind: 'ticks', rows, prior, prevClose, candles: [] };
    }
    const day = await this.source.readDayCandles(symbol);
    const rows = day.flatMap(candlePath);
    return { ...this.#empty(symbol), kind: 'candles', rows, day, prior, prevClose };
  }

  /** Hands out every price whose second the clock has reached. */
  #advance() {
    this.clock.step?.();
    const nowSec = Math.floor(this.clock.now() / 1000);
    for (const st of this.states.values()) {
      while (st.cursor < st.rows.length && st.rows[st.cursor].time <= nowSec) {
        const tick = this.#toTick(st, st.rows[st.cursor++]);
        this.emit('tick', tick);
      }
    }
  }

  #toTick(st, r) {
    if (st.kind === 'candles') {
      st.open ??= r.candle.open;
      st.high = Math.max(st.high ?? -Infinity, r.candle.high);
      st.low = Math.min(st.low ?? Infinity, r.candle.low);
      st.cumVolume = (st.cumVolume ?? 0) + (r.volume || 0);
    } else {
      st.open ??= r.ltp;
      st.high = Math.max(st.high ?? -Infinity, r.ltp);
      st.low = Math.min(st.low ?? Infinity, r.ltp);
      this.#addToCandle(st, r);
    }
    const change = st.prevClose ? Math.round((r.ltp - st.prevClose) * 100) / 100 : null;
    const volume = st.kind === 'candles' ? st.cumVolume : r.volume;
    const depth = r.bids?.length || r.asks?.length ? { bids: r.bids, asks: r.asks } : null;
    const tick = {
      symbol: st.symbol,
      ltp: r.ltp,
      open: st.open,
      high: st.high,
      low: st.low,
      prevClose: st.prevClose,
      change,
      changePct: st.prevClose ? Math.round((change / st.prevClose) * 10000) / 100 : null,
      volume,
      atp: null,
      totalBuyQty: r.totalBuyQty || null,
      totalSellQty: r.totalSellQty || null,
      depth,
      ts: r.time * 1000,
      isIndex: isIndexSymbol(st.symbol),
      source: 'replay',
    };
    st.last = tick;
    return tick;
  }

  /**
   * The price of `symbol` `seconds` after the clock: what a fill that lands a moment late gets (config.fill.delaySec). Null when the symbol
   * is not playing. Looks ahead in the saved data only for this, never for a decision.
   */
  priceAfter(symbol, seconds) {
    const st = this.states.get(symbol);
    if (!st?.rows.length) return null;
    const at = Math.floor(this.clock.now() / 1000) + seconds;
    let price = null;
    for (let i = Math.max(st.cursor - 1, 0); i < st.rows.length && st.rows[i].time <= at; i += 1) price = st.rows[i].ltp;
    return price ?? st.last?.ltp ?? null;
  }

  /** 1-minute candles built from the seconds handed out so far. */
  #addToCandle(st, r) {
    const t = r.time - (r.time % 60);
    const last = st.candles.at(-1);
    if (last && last.time === t) {
      last.high = Math.max(last.high, r.ltp);
      last.low = Math.min(last.low, r.ltp);
      last.close = r.ltp;
      last.volume = Math.max(r.volume - last.startVolume, 0);
    } else {
      st.candles.push({ time: t, open: r.ltp, high: r.ltp, low: r.ltp, close: r.ltp, volume: 0, startVolume: r.volume });
    }
  }

  /** The replay day's 1-minute candles of a symbol up to the clock (the forming minute included for recorded symbols). */
  #today(symbol) {
    const st = this.states.get(symbol);
    if (!st) return [];
    if (st.kind === 'ticks') return st.candles.map(({ startVolume, ...c }) => c);
    if (st.kind === 'candles') {
      const nowSec = Math.floor(this.clock.now() / 1000);
      return st.day.filter((c) => c.time + 59 <= nowSec);
    }
    return [];
  }

  async getHistory(symbol, interval = '1m') {
    await this.#load(symbol);
    const st = this.states.get(symbol);
    const all = [...(st?.prior ?? []), ...this.#today(symbol)].map((c) => ({ ...c }));
    return interval === '1m' ? all : aggregateCandles(all, interval);
  }

  async getRangeHistory(symbol, unit, days) {
    await this.#load(symbol);
    const st = this.states.get(symbol);
    const from = addDays(this.day, -days);
    const all = [...(st?.prior ?? []), ...this.#today(symbol)].filter((c) => istParts(new Date(c.time * 1000)).dateKey >= from).map((c) => ({ ...c }));
    return unit === 1 ? all : aggregateCandles(all, `${unit}m`);
  }

  async getTodayCandles(symbol, unit) {
    await this.#load(symbol);
    const all = this.#today(symbol).map((c) => ({ ...c }));
    return unit === 1 ? all : aggregateCandles(all, `${unit}m`);
  }

  async getTodayOptionCandles(symbol, unit = 1) {
    return this.getTodayCandles(symbol, unit);
  }

  /** Daily candles of the days before the replay day. */
  async getDailyHistory(symbol, days = 45) {
    const st = this.states.get(symbol) ?? (await this.#load(symbol), this.states.get(symbol));
    const byDay = new Map();
    for (const c of st?.prior ?? []) {
      const d = istParts(new Date(c.time * 1000)).dateKey;
      const day = byDay.get(d);
      if (!day) byDay.set(d, { time: c.time - (c.time % 86400) - 19800, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      else Object.assign(day, { high: Math.max(day.high, c.high), low: Math.min(day.low, c.low), close: c.close, volume: day.volume + c.volume });
    }
    return [...byDay.values()].filter((c) => c.time >= (Date.now() - days * 86400000) / 1000);
  }

  /**
   * The contracts that can be bought on the replay day: those with recorded seconds (priced each second) and every strike whose 1-minute
   * candles were saved that evening (priced once a minute), so the at-the-money strike is there all day as on a live day.
   */
  async #contracts() {
    return [...new Set([...this.tickSymbols, ...this.candleOptions])].map((symbol) => ({ symbol, o: parseOptionSymbol(symbol) })).filter((c) => c.o).map(({ symbol, o }) => ({ symbol, strike: o.strike, type: o.type, expiry: o.expiry, lotSize: this.lotSize }));
  }

  /** Has this contract a price at the virtual clock's second? A contract with no known span is assumed priced. */
  #priced(symbol, nowSec) {
    const span = this.spans.get(symbol);
    if (!span) return true;
    return span.first <= nowSec && (span.kind === 'ticks' || nowSec <= span.last + 120);
  }

  /** The contracts that can be bought right now: only those that have a price at the clock, so the one picked always has a premium. */
  async #priced_contracts() {
    const nowSec = Math.floor(this.clock.now() / 1000);
    return (await this.#contracts()).filter((c) => this.#priced(c.symbol, nowSec));
  }

  async getOptionExpiries() {
    return [...new Set((await this.#priced_contracts()).map((c) => c.expiry))].filter((e) => e >= this.day).sort();
  }

  async getOptionContracts(expiry) {
    return (await this.#priced_contracts()).filter((c) => c.expiry === expiry);
  }
}
