import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { BaseProvider } from '../BaseProvider.js';
import { NIFTY50, INDICES, isIndex } from '../../instruments.js';
import { round2 } from '../../../utils/money.js';
import { logger } from '../../../utils/logger.js';
import { totp } from '../../../services/totp.js';
import { MODE, parsePacket, looksSane } from './packet.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(here, '../../../../.cache');
const MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const IST_OFFSET_MS = 330 * 60000;
const NSE_CM = 1;
const BSE_CM = 3;
const INTERVALS = { '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE' };
const REST_GAP_MS = 350; // the candle call allows 3 per second
const PING_MS = 10_000;

// Index tokens are fixed in Angel One's scrip master.
const INDEX_TOKENS = {
  'NIFTY 50': { token: '99926000', exchange: 'NSE', exchangeType: NSE_CM },
  'NIFTY BANK': { token: '99926009', exchange: 'NSE', exchangeType: NSE_CM },
  SENSEX: { token: '99919000', exchange: 'BSE', exchangeType: BSE_CM },
};

const pad = (n) => String(n).padStart(2, '0');
const istStamp = (ms) => {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/**
 * Angel One SmartAPI adapter: login with client code, PIN and a time-based code made from your
 * TOTP secret (so no daily manual login), live quotes over the SmartAPI WebSocket 2.0 in
 * SNAP_QUOTE mode (price, volume and five levels of order book), and candles over REST.
 *
 * IMPORTANT: written from Angel One's published API shape without access to their docs or a live
 * account in the build environment. Run `npm run angel:check` first and send the output if
 * anything looks off. A packet that fails the sanity checks is dropped, never shown as a price.
 */
export class AngelOneProvider extends BaseProvider {
  constructor(
    { apiKey, clientCode, pin, totpSecret, apiBase = 'https://apiconnect.angelone.in', wsUrl = 'wss://smartapisocket.angelone.in/smart-stream', publicIp = '127.0.0.1' },
    { fetchImpl = fetch, WebSocketImpl = WebSocket, now = () => Date.now(), cache = true } = {},
  ) {
    super();
    Object.assign(this, { apiKey, clientCode, pin, totpSecret, apiBase, wsUrl, publicIp });
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.now = now;
    this.useCache = cache;
    this.session = null;
    this.byKey = new Map(); // `${exchangeType}|${token}` -> symbol
    this.refBySymbol = new Map(); // symbol -> { token, exchange, exchangeType }
    this.subscribed = new Set();
    this.ws = null;
    this.pingTimer = null;
    this.retry = 0;
    this.stopped = false;
    this.bearerOnSocket = false;
    this.lastRest = 0;
    this.lastInsane = 0;
  }

  get name() {
    return 'angelone';
  }

  get capabilities() {
    return { depth: true, history: true, giftNifty: false };
  }

  async connect() {
    this.stopped = false;
    for (const [k, v] of Object.entries({ ANGELONE_API_KEY: this.apiKey, ANGELONE_CLIENT_CODE: this.clientCode, ANGELONE_PIN: this.pin, ANGELONE_TOTP_SECRET: this.totpSecret })) {
      if (!v) throw new Error(`${k} is empty. Fill the Angel One values in server/.env`);
    }
    await this.#login();
    await this.#loadTokens();
    await this.#open();
  }

  async disconnect() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus(false, 'Disconnected');
  }

  async subscribe(symbols) {
    const fresh = symbols.filter((s) => this.refBySymbol.has(s) && !this.subscribed.has(s));
    fresh.forEach((s) => this.subscribed.add(s));
    this.#sendSubscribe(fresh);
  }

  async getHistory(symbol, interval = '1m') {
    const ref = this.refBySymbol.get(symbol);
    if (!ref || !INTERVALS[interval]) return [];
    const days = interval === '1m' ? 4 : 10;
    const to = this.now();
    const from = to - days * 86400_000;
    const res = await this.#rest('POST', '/rest/secure/angelbroking/historical/v1/getCandleData', {
      exchange: ref.exchange,
      symboltoken: ref.token,
      interval: INTERVALS[interval],
      fromdate: istStamp(from),
      todate: istStamp(to),
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    const seen = new Map();
    for (const [ts, open, high, low, close, volume] of rows) {
      const time = Math.floor(new Date(ts).getTime() / 1000);
      if (Number.isFinite(time)) seen.set(time, { time, open, high, low, close, volume: volume || 0 });
    }
    return [...seen.values()].sort((a, b) => a.time - b.time);
  }

  // ---- REST ----

  #headers(auth) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': this.publicIp,
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': this.apiKey,
    };
    if (auth) h.Authorization = `Bearer ${this.session.jwt}`;
    return h;
  }

  async #rest(method, urlPath, body, { auth = true, retried = false } = {}) {
    const wait = this.lastRest + REST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRest = Date.now();
    const res = await this.fetch(`${this.apiBase}${urlPath}`, { method, headers: this.#headers(auth), body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (/exceeding access rate/i.test(text) && !retried) {
        await new Promise((r) => setTimeout(r, 1100));
        return this.#rest(method, urlPath, body, { auth, retried: true });
      }
      throw new Error(`Angel One returned HTTP ${res.status}: ${text.slice(0, 120)}`);
    }
    if (json.status === false || json.success === false) {
      if (/exceeding access rate/i.test(json.message || '') && !retried) {
        await new Promise((r) => setTimeout(r, 1100));
        return this.#rest(method, urlPath, body, { auth, retried: true });
      }
      throw Object.assign(new Error(`${json.message || 'request failed'}${json.errorcode ? ` (${json.errorcode})` : ''}`), { errorcode: json.errorcode });
    }
    return json;
  }

  async #login() {
    let json;
    try {
      json = await this.#rest('POST', '/rest/auth/angelbroking/user/v1/loginByPassword', { clientcode: this.clientCode, password: this.pin, totp: totp(this.totpSecret, this.now()) }, { auth: false });
    } catch (err) {
      throw new Error(`Angel One login failed: ${err.message}. Check the client code, PIN and TOTP secret, and that this computer's clock is correct.`);
    }
    const d = json.data || {};
    if (!d.jwtToken || !d.feedToken) throw new Error('Angel One login did not return tokens');
    this.session = { jwt: String(d.jwtToken).replace(/^Bearer\s+/i, ''), refresh: d.refreshToken, feed: d.feedToken, at: this.now() };
  }

  // ---- instruments ----

  async #loadTokens() {
    for (const idx of INDICES) {
      const ref = INDEX_TOKENS[idx.symbol];
      if (ref) this.#map(idx.symbol, ref);
    }
    const tokens = await this.#stockTokens();
    const missing = [];
    for (const { symbol } of NIFTY50) {
      if (tokens[symbol]) this.#map(symbol, { token: tokens[symbol], exchange: 'NSE', exchangeType: NSE_CM });
      else missing.push(symbol);
    }
    if (missing.length) logger.warn(`Angel One: no token for ${missing.join(', ')}`);
  }

  // Downloads Angel One's public scrip master (large, so only once a day) and keeps the NSE "-EQ" tokens of the Nifty 50.
  async #stockTokens() {
    const day = new Date(this.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const cacheFile = path.join(CACHE_DIR, `angelone-nse-${day}.json`);
    if (this.useCache) {
      try {
        return JSON.parse(await readFile(cacheFile, 'utf8'));
      } catch {
        // not cached yet
      }
    }
    const res = await this.fetch(MASTER_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Could not download the Angel One scrip master (HTTP ${res.status})`);
    const rows = await res.json();
    const wanted = new Map(NIFTY50.map((s) => [`${s.symbol}-EQ`, s.symbol]));
    const map = {};
    for (const r of rows) if (r.exch_seg === 'NSE' && wanted.has(r.symbol)) map[wanted.get(r.symbol)] = String(r.token);
    if (this.useCache) {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(map, null, 2));
    }
    return map;
  }

  #map(symbol, ref) {
    this.refBySymbol.set(symbol, ref);
    this.byKey.set(`${ref.exchangeType}|${ref.token}`, symbol);
  }

  // ---- WebSocket ----

  async #open() {
    const headers = {
      Authorization: this.bearerOnSocket ? `Bearer ${this.session.jwt}` : this.session.jwt,
      'x-api-key': this.apiKey,
      'x-client-code': this.clientCode,
      'x-feed-token': this.session.feed,
    };
    const ws = new this.WebSocket(this.wsUrl, { headers });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;
    let opened = false;

    ws.on('open', () => {
      opened = true;
      this.retry = 0;
      this.setStatus(true, 'Connected to Angel One feed');
      this.#sendSubscribe([...this.subscribed]);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_MS);
      this.pingTimer.unref?.();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.#onPacket(data);
      const text = data.toString();
      if (text !== 'pong') logger.warn(`Angel One feed message: ${text.slice(0, 200)}`);
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) this.bearerOnSocket = !this.bearerOnSocket; // try the other header form next time
      logger.warn(`Angel One feed refused the connection (HTTP ${res.statusCode})`);
    });
    ws.on('error', (err) => logger.warn(`Angel One socket error: ${err.message}`));
    ws.on('close', () => {
      clearInterval(this.pingTimer);
      this.setStatus(false, 'Angel One feed disconnected');
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      logger.warn(`Angel One feed closed, reconnecting in ${delay}ms`);
      setTimeout(async () => {
        try {
          // The session may have expired overnight, so sign in again before reconnecting.
          if (!opened || this.now() - this.session.at > 4 * 3600_000) await this.#login();
          await this.#open();
        } catch (e) {
          logger.error('Angel One reconnect failed:', e.message);
          ws.emit('close');
        }
      }, delay).unref?.();
    });
  }

  #sendSubscribe(symbols) {
    if (!symbols.length || this.ws?.readyState !== WebSocket.OPEN) return; // re-sent on open
    const byType = new Map();
    for (const s of symbols) {
      const ref = this.refBySymbol.get(s);
      byType.set(ref.exchangeType, [...(byType.get(ref.exchangeType) || []), ref.token]);
    }
    const tokenList = [...byType].map(([exchangeType, tokens]) => ({ exchangeType, tokens }));
    this.ws.send(JSON.stringify({ correlationID: 'nifty-paper', action: 1, params: { mode: MODE.SNAP_QUOTE, tokenList } }));
  }

  #onPacket(buf) {
    const pkt = parsePacket(buf);
    if (!pkt) return;
    const symbol = this.byKey.get(`${pkt.exchangeType}|${pkt.token}`);
    if (!symbol) return;
    if (!looksSane(pkt)) {
      if (this.now() - this.lastInsane > 60_000) {
        this.lastInsane = this.now();
        logger.warn(`Angel One packet for ${symbol} failed sanity checks and was dropped (ltp ${pkt.ltp}, high ${pkt.high}, low ${pkt.low}). The packet layout may differ: run npm run angel:check`);
      }
      return;
    }
    this.emit('tick', toTick(symbol, pkt, this.now()));
  }
}

/** Convert a decoded packet into the app's normalized tick. Exported for tests. */
export function toTick(symbol, pkt, nowMs = Date.now()) {
  const prevClose = pkt.prevClose || null;
  const change = prevClose ? round2(pkt.ltp - prevClose) : null;
  const book = pkt.depth;
  const bids = book?.bids.filter((b) => b.price > 0).sort((a, b) => b.price - a.price).slice(0, 5) ?? [];
  const asks = book?.asks.filter((a) => a.price > 0).sort((a, b) => a.price - b.price).slice(0, 5) ?? [];
  return {
    symbol,
    ltp: pkt.ltp,
    open: pkt.open || null,
    high: pkt.high || null,
    low: pkt.low || null,
    prevClose,
    change,
    changePct: prevClose ? round2((change / prevClose) * 100) : null,
    volume: pkt.volume || null,
    atp: pkt.atp || null,
    totalBuyQty: pkt.totalBuyQty || null,
    totalSellQty: pkt.totalSellQty || null,
    depth: bids.length || asks.length ? { bids: bids.map(({ price, qty }) => ({ price, qty })), asks: asks.map(({ price, qty }) => ({ price, qty })) } : null,
    ts: pkt.exchangeTs > 0 ? pkt.exchangeTs : nowMs,
    isIndex: isIndex(symbol),
    source: 'angelone',
  };
}
