import crypto from 'node:crypto';
import { NIFTY50 } from '../market/instruments.js';
import { NewsItem } from '../models/index.js';
import { logger } from '../utils/logger.js';
import { parseRss } from './rss.js';
import { tagHeadline } from './tagger.js';
import { reactionTo } from './reaction.js';

export const MARKET = 'MARKET';
const FRESH_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 72 * 60 * 60 * 1000;

const googleNews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
const MARKET_FEEDS = [
  googleNews('Nifty OR Sensex OR "stock market" India when:1d'),
  googleNews('RBI OR "Union Budget" OR "FII" India markets when:1d'),
];

/** Words in a company's name that should appear in a headline about it. */
function nameKey(stock) {
  const first = stock.name.split(/[\s&.,'-]+/).filter(Boolean)[0];
  return first && first.length >= 3 ? first.toLowerCase() : stock.symbol.toLowerCase();
}

export async function defaultFetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NiftyPaperTrader/1.0)' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.text();
}

/**
 * Collects free headlines for the Nifty 50 (Google News RSS) and tags each with a sentiment.
 * Headlines are refreshed a few stocks per cycle so a full pass takes about ten minutes and the
 * feeds are never hammered. `fetchText` and `tagger` can be swapped (tests, or an AI tagger).
 */
export class NewsService {
  constructor({ market, store, fetchText = defaultFetchText, tagger = tagHeadline, now = () => new Date(), intervalMs = 60_000, perCycle = 5 }) {
    this.market = market;
    this.store = store; // scanner candle store, used for the "does the market agree" check
    this.fetchText = fetchText;
    this.tagger = tagger;
    this.now = now;
    this.intervalMs = intervalMs;
    this.perCycle = perCycle;
    this.queue = [MARKET, ...NIFTY50.map((s) => s.symbol)];
    this.cursor = 0;
    this.lastRefresh = null;
    this.cache = new Map(); // symbol -> items (newest first), refilled from Mongo/feeds
  }

  start() {
    const run = () => this.refreshSome().catch((e) => logger.error('news refresh failed', e));
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async refreshSome(n = this.perCycle) {
    for (let i = 0; i < n; i++) {
      const symbol = this.queue[this.cursor];
      this.cursor = (this.cursor + 1) % this.queue.length;
      try {
        await this.refresh(symbol);
      } catch (err) {
        logger.warn(`News for ${symbol} unavailable: ${err.message}`);
      }
    }
    this.lastRefresh = this.now().toISOString();
  }

  async refresh(symbol) {
    const urls = symbol === MARKET ? MARKET_FEEDS : [googleNews(`${this.#query(symbol)} when:2d`)];
    const stock = NIFTY50.find((s) => s.symbol === symbol);
    const cutoff = this.now().getTime() - KEEP_MS;
    const seen = new Set();
    const fresh = [];
    let failure = null;
    let worked = 0;
    for (const url of urls) {
      let xml;
      try {
        xml = await this.fetchText(url);
        worked++;
      } catch (err) {
        failure = err; // another feed for the same symbol may still work
        continue;
      }
      for (const it of parseRss(xml)) {
        if (it.publishedAt.getTime() < cutoff || it.publishedAt.getTime() > this.now().getTime() + 5 * 60_000) continue;
        if (stock && !it.title.toLowerCase().includes(nameKey(stock))) continue; // Google returns loose matches
        const hash = crypto.createHash('sha1').update(it.title.toLowerCase()).digest('hex').slice(0, 16);
        if (seen.has(hash)) continue;
        seen.add(hash);
        fresh.push({ ...it, hash });
      }
    }
    if (!worked) throw failure;
    for (const it of fresh) {
      const tag = this.tagger(it.title);
      try {
        await NewsItem.updateOne({ symbol, hash: it.hash }, { $setOnInsert: { symbol, ...it, ...tag } }, { upsert: true });
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
    this.cache.delete(symbol);
  }

  #query(symbol) {
    const stock = NIFTY50.find((s) => s.symbol === symbol);
    return `"${stock.name}" share OR stock`;
  }

  #decorate(docs, symbol) {
    const c1 = symbol === MARKET ? null : this.store?.get(symbol);
    const ltp = symbol === MARKET ? null : this.market.getTick(symbol)?.ltp;
    return docs.map((d) => ({
      id: String(d._id),
      title: d.title,
      url: d.url,
      source: d.source,
      publishedAt: d.publishedAt,
      label: d.label,
      sentiment: d.sentiment,
      category: d.category,
      reasons: d.reasons,
      reaction: reactionTo({ label: d.label, publishedAt: d.publishedAt, c1, ltp, now: this.now() }),
    }));
  }

  /** Recent headlines, newest first, each with whether the market agrees. */
  async forSymbol(symbol, { hours = 48, limit = 20 } = {}) {
    const since = new Date(this.now().getTime() - hours * 3600_000);
    const docs = await NewsItem.find({ symbol, publishedAt: { $gte: since, $lte: this.now() } }).sort({ publishedAt: -1 }).limit(limit).lean();
    return this.#decorate(docs, symbol);
  }

  /** One verdict per stock from the last 24 hours (see `summarise`), for every Nifty 50 stock with news. */
  async signals() {
    const since = new Date(this.now().getTime() - FRESH_MS);
    const docs = await NewsItem.find({ symbol: { $ne: MARKET }, publishedAt: { $gte: since, $lte: this.now() }, label: { $ne: 'NEUTRAL' } }).sort({ publishedAt: -1 }).lean();
    const bySymbol = new Map();
    for (const d of docs) bySymbol.set(d.symbol, [...(bySymbol.get(d.symbol) || []), d]);
    const out = {};
    for (const [symbol, list] of bySymbol) {
      const sig = summarise(this.#decorate(list.slice(0, 10), symbol));
      if (sig) out[symbol] = sig;
    }
    return out;
  }
}

/**
 * The sum of sentiment, the strongest headline and whether the price confirms it.
 * `items` are decorated headlines with a non-neutral label. Returns null when they cancel out.
 */
export function summarise(items) {
  if (!items.length) return null;
  const net = Math.round(items.reduce((s, i) => s + i.sentiment, 0) * 10) / 10;
  const label = net >= 1 ? 'BULLISH' : net <= -1 ? 'BEARISH' : null;
  if (!label) return null;
  const lead = items.filter((i) => i.label === label).sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))[0];
  return { label, net, count: items.length, title: lead.title, source: lead.source, publishedAt: lead.publishedAt, reaction: lead.reaction?.state ?? null, movePct: lead.reaction?.movePct ?? null };
}
