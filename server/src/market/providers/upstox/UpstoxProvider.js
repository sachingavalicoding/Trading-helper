import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import WebSocket from 'ws';
import { BaseProvider } from '../BaseProvider.js';
import { NIFTY50, INDICES, isIndex } from '../../instruments.js';
import { round2 } from '../../../utils/money.js';
import { logger } from '../../../utils/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(here, 'MarketDataFeedV3.proto');
const CACHE_DIR = path.join(here, '../../../../.cache');
const INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const IST_OFFSET_MS = 330 * 60000;

/**
 * Upstox Market Data Feed V3 adapter.
 * Docs: https://upstox.com/developer/api-documentation/v3/get-market-data-feed
 *
 * Flow: GET /v3/feed/market-data-feed/authorize -> one-time wss URL -> send a binary JSON
 * subscribe frame -> receive protobuf FeedResponse messages (decoded with MarketDataFeedV3.proto).
 * Access tokens expire every day around 03:30 IST, so UPSTOX_ACCESS_TOKEN needs refreshing daily.
 */
export class UpstoxProvider extends BaseProvider {
  constructor({ accessToken, apiBase = 'https://api.upstox.com', instrumentMapFile = '' }) {
    super();
    this.accessToken = accessToken;
    this.apiBase = apiBase;
    this.instrumentMapFile = instrumentMapFile;
    this.keyBySymbol = new Map();
    this.symbolByKey = new Map();
    this.subscribed = new Set();
    this.ws = null;
    this.FeedResponse = null;
    this.retry = 0;
    this.stopped = false;
  }

  get name() {
    return 'upstox';
  }

  get capabilities() {
    return { depth: true, history: true, giftNifty: false };
  }

  async connect() {
    this.stopped = false;
    if (!this.accessToken) throw new Error('UPSTOX_ACCESS_TOKEN is empty');
    const root = await protobuf.load(PROTO_PATH);
    this.FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
    await this.#loadInstrumentKeys();
    await this.#open();
  }

  async disconnect() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.setStatus(false, 'Disconnected');
  }

  async subscribe(symbols) {
    const keys = [];
    for (const sym of symbols) {
      const key = this.keyBySymbol.get(sym);
      if (key && !this.subscribed.has(key)) {
        this.subscribed.add(key);
        keys.push(key);
      }
    }
    if (keys.length) this.#send('sub', keys);
  }

  async getHistory(symbol, interval = '1m') {
    const key = this.keyBySymbol.get(symbol);
    if (!key) return [];
    const unit = Number.parseInt(interval, 10) || 1;
    const enc = encodeURIComponent(key);
    const candles = [];

    // Earlier sessions first (so charts have context before 09:15 or on holidays), then today.
    const to = new Date(Date.now() + IST_OFFSET_MS);
    to.setUTCDate(to.getUTCDate() - 1);
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - (unit === 1 ? 4 : 10));
    const day = (d) => d.toISOString().slice(0, 10);
    try {
      const hist = await this.#get(`/v3/historical-candle/${enc}/minutes/${unit}/${day(to)}/${day(from)}`);
      candles.push(...(hist?.data?.candles || []));
    } catch (err) {
      logger.warn(`Upstox historical candles failed for ${symbol}: ${err.message}`);
    }
    try {
      const intraday = await this.#get(`/v3/historical-candle/intraday/${enc}/minutes/${unit}`);
      candles.push(...(intraday?.data?.candles || []));
    } catch (err) {
      logger.warn(`Upstox intraday candles failed for ${symbol}: ${err.message}`);
    }

    // Upstox returns [timestamp, open, high, low, close, volume, oi], newest first.
    const seen = new Map();
    for (const [ts, open, high, low, close, volume] of candles) {
      const time = Math.floor(new Date(ts).getTime() / 1000);
      seen.set(time, { time, open, high, low, close, volume: volume || 0 });
    }
    return [...seen.values()].sort((a, b) => a.time - b.time);
  }

  async getDailyHistory(symbol, days = 45) {
    const key = this.keyBySymbol.get(symbol);
    if (!key) return [];
    const to = new Date(Date.now() + IST_OFFSET_MS);
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - days);
    const day = (d) => d.toISOString().slice(0, 10);
    try {
      const hist = await this.#get(`/v3/historical-candle/${encodeURIComponent(key)}/days/1/${day(to)}/${day(from)}`);
      return (hist?.data?.candles || [])
        .map(([ts, open, high, low, close, volume]) => ({ time: Math.floor(new Date(ts).getTime() / 1000), open, high, low, close, volume: volume || 0 }))
        .sort((a, b) => a.time - b.time);
    } catch (err) {
      logger.warn(`Upstox daily candles failed for ${symbol}: ${err.message}`);
      return [];
    }
  }

  async #get(urlPath) {
    const res = await fetch(`${this.apiBase}${urlPath}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async #loadInstrumentKeys() {
    for (const idx of INDICES) this.#map(idx.symbol, idx.upstoxKey);

    let map = null;
    if (this.instrumentMapFile) {
      map = JSON.parse(await readFile(this.instrumentMapFile, 'utf8'));
    } else {
      map = await this.#instrumentMapFromMaster();
    }
    const missing = [];
    for (const { symbol } of NIFTY50) {
      if (map[symbol]) this.#map(symbol, map[symbol]);
      else missing.push(symbol);
    }
    if (missing.length) logger.warn(`Upstox: no instrument key for ${missing.join(', ')}`);
  }

  // Downloads Upstox's public NSE instrument master once a day and keeps NSE_EQ keys for Nifty 50 symbols.
  async #instrumentMapFromMaster() {
    const cacheFile = path.join(CACHE_DIR, `upstox-nse-${new Date().toISOString().slice(0, 10)}.json`);
    try {
      return JSON.parse(await readFile(cacheFile, 'utf8'));
    } catch {
      // not cached yet
    }
    const res = await fetch(INSTRUMENTS_URL);
    if (!res.ok) throw new Error(`Could not download Upstox instrument master (HTTP ${res.status})`);
    const rows = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
    const wanted = new Set(NIFTY50.map((s) => s.symbol));
    const map = {};
    for (const r of rows) {
      if (r.segment === 'NSE_EQ' && r.instrument_type === 'EQ' && wanted.has(r.trading_symbol)) {
        map[r.trading_symbol] = r.instrument_key;
      }
    }
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(map, null, 2));
    return map;
  }

  #map(symbol, key) {
    this.keyBySymbol.set(symbol, key);
    this.symbolByKey.set(key, symbol);
  }

  async #open() {
    let auth;
    try {
      auth = await this.#get('/v3/feed/market-data-feed/authorize');
    } catch (err) {
      if (err.message.startsWith('HTTP 401')) throw new Error('Upstox access token is invalid or expired (they expire around 03:30 IST daily)');
      throw err;
    }
    const url = auth?.data?.authorized_redirect_uri;
    if (!url) throw new Error('Upstox authorize did not return a websocket URL');

    const ws = new WebSocket(url, { followRedirects: true });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.retry = 0;
      this.setStatus(true, 'Connected to Upstox feed');
      if (this.subscribed.size) this.#send('sub', [...this.subscribed]);
    });
    ws.on('message', (buf) => this.#onMessage(buf));
    ws.on('error', (err) => logger.warn(`Upstox socket error: ${err.message}`));
    ws.on('close', () => {
      this.setStatus(false, 'Upstox feed disconnected');
      if (this.stopped) return;
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      logger.warn(`Upstox feed closed, reconnecting in ${delay}ms`);
      setTimeout(() => this.#open().catch((e) => logger.error('Upstox reconnect failed:', e.message)), delay).unref?.();
    });
  }

  #send(method, instrumentKeys) {
    if (this.ws?.readyState !== WebSocket.OPEN) return; // re-sent on open
    const frame = { guid: randomUUID(), method, data: { mode: 'full', instrumentKeys } };
    this.ws.send(Buffer.from(JSON.stringify(frame)));
  }

  #onMessage(buf) {
    let msg;
    try {
      msg = this.FeedResponse.toObject(this.FeedResponse.decode(buf), { longs: Number, enums: String, defaults: false });
    } catch (err) {
      logger.warn(`Upstox decode failed: ${err.message}`);
      return;
    }
    if (!msg.feeds) return;
    for (const [key, feed] of Object.entries(msg.feeds)) {
      const symbol = this.symbolByKey.get(key);
      if (!symbol) continue;
      const tick = parseFeed(symbol, feed, msg.currentTs);
      if (tick) this.emit('tick', tick);
    }
  }
}

/** Convert one decoded Upstox Feed into the app's normalized tick. Exported for tests. */
export function parseFeed(symbol, feed, currentTs) {
  const full = feed.fullFeed?.marketFF || feed.fullFeed?.indexFF;
  const ltpc = full?.ltpc || feed.ltpc;
  if (!ltpc?.ltp) return null;

  const day = full?.marketOHLC?.ohlc?.find((o) => o.interval === '1d');
  const prevClose = ltpc.cp || null;
  const change = prevClose ? round2(ltpc.ltp - prevClose) : null;
  const quotes = full?.marketLevel?.bidAskQuote || [];
  const depth = quotes.length
    ? {
        bids: quotes.slice(0, 5).map((q) => ({ price: q.bidP || 0, qty: q.bidQ || 0 })),
        asks: quotes.slice(0, 5).map((q) => ({ price: q.askP || 0, qty: q.askQ || 0 })),
      }
    : null;

  return {
    symbol,
    ltp: ltpc.ltp,
    open: day?.open ?? null,
    high: day?.high ?? null,
    low: day?.low ?? null,
    prevClose,
    change,
    changePct: prevClose ? round2((change / prevClose) * 100) : null,
    volume: full?.vtt ?? day?.vol ?? null,
    atp: full?.atp || null,
    totalBuyQty: full?.tbq ?? null,
    totalSellQty: full?.tsq ?? null,
    depth,
    ts: ltpc.ltt || currentTs || Date.now(),
    isIndex: isIndex(symbol),
    source: 'upstox',
  };
}
