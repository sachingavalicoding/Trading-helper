import { EventEmitter } from 'node:events';
import { ALL_SYMBOLS, INDICES, NIFTY50 } from './instruments.js';
import { getMarketStatus } from './marketHours.js';
import { INTERVAL_SECONDS } from './providers/BaseProvider.js';
import { UNDERLYING, atmStrike, chooseExpiry, weeklyExpiries } from '../options/symbols.js';

const HISTORY_TTL_MS = 30000;

/**
 * Single owner of the provider connection. Keeps the latest tick per symbol and
 * re-emits ticks for the order engine and the Socket.IO relay.
 */
const DAILY_TTL_MS = 6 * 60 * 60 * 1000;
const DAILY_DAYS = 45;

export class MarketDataService extends EventEmitter {
  constructor(provider, { holidays = [], expiryWeekday } = {}) {
    super();
    this.setMaxListeners(50);
    this.provider = provider;
    this.holidays = holidays;
    this.expiryWeekday = expiryWeekday;
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
      market: getMarketStatus(now, this.holidays),
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
