import { BaseProvider, aggregateCandles } from '../market/providers/BaseProvider.js';
import { INDICES } from '../market/instruments.js';
import { isOptionSymbol, parseOptionSymbol } from '../options/symbols.js';
import { istParts } from '../market/marketHours.js';
import { addDays } from '../market/days.js';

// Plays one recorded day back as if it were live. The Nifty index and the option contracts come from the recorded seconds; shares come
// from the saved 1-minute candles (one price a minute, so they move in steps). A price is handed out only when the virtual clock reaches
// its second, and candle history is cut at the clock, so nothing from the "future" is ever visible.
//
// `source` supplies the data (see mongoSource.js): tickSymbols(), readTicks(symbol), readDayCandles(symbol), readPrior(symbol, fromDay).

const PRIOR_DAYS = 12; // calendar days of earlier candles kept for charts and indicators
const isIndexSymbol = (s) => INDICES.some((i) => i.symbol === s);

export class ReplayProvider extends BaseProvider {
  constructor({ source, clock, day, lotSize = 65, pollMs = 200 }) {
    super();
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
    this.tickSymbols = new Set(await this.source.tickSymbols());
    this.candleOptions = new Set((await this.source.optionCandleSymbols?.()) ?? []);
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
          .catch(() => this.states.set(symbol, this.#empty(symbol)))
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
    // one price a minute, at the minute's last second; the first one is the candle's open so the day opens where it did
    const rows = day.map((c) => ({ time: c.time + 59, ltp: c.close, volume: c.volume, candle: c, bids: [], asks: [], totalBuyQty: 0, totalSellQty: 0 }));
    return { ...this.#empty(symbol), kind: 'candles', rows, day, prior, prevClose };
  }

  /** Hands out every price whose second the clock has reached. */
  #advance() {
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

  async getOptionExpiries() {
    return [...new Set((await this.#contracts()).map((c) => c.expiry))].filter((e) => e >= this.day).sort();
  }

  async getOptionContracts(expiry) {
    return (await this.#contracts()).filter((c) => c.expiry === expiry);
  }
}
