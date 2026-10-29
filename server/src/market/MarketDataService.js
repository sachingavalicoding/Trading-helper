import { EventEmitter } from 'node:events';
import { ALL_SYMBOLS, INDICES, NIFTY50 } from './instruments.js';
import { getMarketStatus } from './marketHours.js';
import { INTERVAL_SECONDS, aggregateCandles } from './providers/BaseProvider.js';
import { istParts } from './marketHours.js';
import { addDays, daysBetween } from './days.js';
import { UNDERLYING, atmStrike, chooseExpiry, weeklyExpiries } from '../options/symbols.js';

const HISTORY_TTL_MS = 30000;

/**
 * Single owner of the provider connection. Keeps the latest tick per symbol and
 * re-emits ticks for the order engine and the Socket.IO relay.
 */
const DAILY_TTL_MS = 6 * 60 * 60 * 1000;
const DAILY_DAYS = 45;

export class MarketDataService extends EventEmitter {
  constructor(provider, { holidays = [], expiryWeekday, enforceHours = false } = {}) {
    super();
    this.setMaxListeners(50);
    this.provider = provider;
    this.holidays = holidays;
    this.expiryWeekday = expiryWeekday;
    this.enforceHours = enforceHours; // tells the app whether the order engine refuses orders outside market hours
    this.history = null; // the saved candle history (HistoryStore), set by HistorySync; studies and Review read it first
    this.latest = new Map();
    this.historyCache = new Map();
    this.feedStatus = { connected: false, message: 'Not started' };
    this.contracts = new Map(); // option symbol -> { symbol, strike, type, expiry, lotSize } for every contract picked so far

    provider.on('tick', (tick) => {
      this.latest.set(tick.symbol, tick);
      this.emit('tick', tick);
    });
    provider.on('status', (status) => {
      this.feedStatus = status;
      this.emit('status', this.status());
    });
  }

  async start() {
    await this.provider.connect();
    await this.provider.subscribe(ALL_SYMBOLS);
  }

  async stop() {
    await this.provider.disconnect();
  }

  getTick(symbol) {
    return this.latest.get(symbol) || null;
  }

  getLtp(symbol) {
    return this.latest.get(symbol)?.ltp ?? null;
  }

  snapshot() {
    return {
      stocks: NIFTY50.map((s) => ({ ...s, seed: undefined, tick: this.latest.get(s.symbol) || null })),
      indices: INDICES.map((s) => ({ symbol: s.symbol, name: s.name, tick: this.latest.get(s.symbol) || null })),
    };
  }

  status(now = new Date()) {
    return {
      market: { ...getMarketStatus(now, this.holidays), enforced: this.enforceHours },
      feed: {
        provider: this.provider.name,
        simulated: this.provider.isSimulated,
        connected: this.feedStatus.connected,
        message: this.feedStatus.message,
        capabilities: this.provider.capabilities,
      },
    };
  }

  /** Lot size of an option contract this service has picked, or undefined for anything else. */
  lotSize(symbol) {
    return this.contracts.get(symbol)?.lotSize;
  }

  /**
   * The at-the-money Nifty contract of `type` ('CE' or 'PE') for the expiry worth buying, started streaming so it has a price.
   * Returns null when the feed lists no contracts or the Nifty has no price yet.
   */
  async pickOption({ type, now = new Date(), minDays = 1 }) {
    const spot = this.getLtp(UNDERLYING);
    if (!spot) return null;
    const listed = await this.provider.getOptionExpiries();
    const expiries = listed.length ? listed : weeklyExpiries(now, { holidays: this.holidays, weekday: this.expiryWeekday });
    const expiry = chooseExpiry(expiries, now, { minDays });
    if (!expiry) return null;
    const atm = atmStrike(spot);
    const pick = (await this.provider.getOptionContracts(expiry))
      .filter((c) => c.type === type)
      .sort((a, b) => Math.abs(a.strike - atm) - Math.abs(b.strike - atm))[0];
    if (!pick) return null;
    this.contracts.set(pick.symbol, pick);
    await this.provider.subscribe([pick.symbol]);
    return { ...pick, ltp: this.getLtp(pick.symbol), spot };
  }

  /** Start streaming a contract (e.g. one that is already held after a restart). */
  async watchOption(symbol, contract = null) {
    if (contract) this.contracts.set(symbol, contract);
    await this.provider.subscribe([symbol]);
  }

  /** About `days` days of daily candles, cached for hours: the last month does not change while trading. */
  async getDaily(symbol, days = DAILY_DAYS) {
    const key = `${symbol}|1d`;
    const hit = this.historyCache.get(key);
    if (hit && Date.now() - hit.at < DAILY_TTL_MS) return hit.candles;
    const candles = await this.provider.getDailyHistory(symbol, days);
    if (candles.length) this.historyCache.set(key, { at: Date.now(), candles });
    return candles;
  }

  /** `days` calendar days of `unit`-minute candles for the study, cached for half an hour. */
  async getRange(symbol, unit, days) {
    const key = `${symbol}|r${unit}|${days}`;
    const hit = this.historyCache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60000) return hit.candles;
    const candles = await this.provider.getRangeHistory(symbol, unit, days);
    this.historyCache.set(key, { at: Date.now(), candles });
    return candles;
  }

  /**
   * `days` calendar days of `unit`-minute candles for a study. From the saved history when the symbol has some (plus whatever came after it,
   * today included, from the broker); otherwise straight from the broker as `getRange`.
   */
  async getStudyRange(symbol, unit, days) {
    const cov = this.history ? await this.history.coverage(symbol).catch(() => null) : null;
    if (!cov) return this.getRange(symbol, unit, days);
    const today = istParts(new Date()).dateKey;
    // a day saved only up to some time of an earlier date is read again from the broker, whole
    const upTo = cov.partial && cov.partial < today ? addDays(cov.partial, -1) : cov.to;
    const stored = await this.history.read(symbol, addDays(today, -days), upTo);
    const since = daysBetween(upTo, today);
    const tail = since >= 1 ? (await this.getRange(symbol, 1, since + 1)).filter((c) => istParts(new Date(c.time * 1000)).dateKey > upTo) : [];
    const merged = [...new Map([...stored, ...tail].map((c) => [c.time, c])).values()].sort((a, b) => a.time - b.time);
    return unit === 1 ? merged : aggregateCandles(merged.map((c) => ({ ...c })), `${unit}m`);
  }

  /** The 1-minute candles around `day` for Review: the broker's last sessions plus the saved days before and after it, so an older day has its chart. */
  async getMinutes(symbol, day) {
    const live = await this.getCandles(symbol, '1m').catch(() => []);
    if (!this.history) return live;
    const stored = await this.history.read(symbol, addDays(day, -9), addDays(day, 1)).catch(() => []);
    if (!stored.length) return live;
    return [...new Map([...stored, ...live].map((c) => [c.time, c])).values()].sort((a, b) => a.time - b.time);
  }

  async getCandles(symbol, interval) {
    if (!INTERVAL_SECONDS[interval]) throw new Error(`Unsupported interval ${interval}`);
    // The mock feed builds history in memory, so it is always fresh; broker APIs are rate limited.
    if (this.provider.isSimulated) return this.provider.getHistory(symbol, interval);
    const key = `${symbol}|${interval}`;
    const hit = this.historyCache.get(key);
    if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.candles;
    const candles = await this.provider.getHistory(symbol, interval);
    this.historyCache.set(key, { at: Date.now(), candles });
    return candles;
  }
}
