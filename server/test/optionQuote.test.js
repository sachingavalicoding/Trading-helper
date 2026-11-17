import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MarketDataService } from '../src/market/MarketDataService.js';

const SYMBOL = 'NIFTY-20261123-25300-PE';

/** A broker feed like Upstox: a contract can be subscribed only once its instrument key is known, which reading the contract list does. */
class FakeFeed extends EventEmitter {
  constructor({ candles = [] } = {}) {
    super();
    this.keys = new Set();
    this.subscribed = [];
    this.listReads = 0;
    this.candles = candles;
  }
  async getOptionContracts(expiry) {
    this.listReads += 1;
    this.keys.add(SYMBOL);
    return [{ symbol: SYMBOL, strike: 25300, type: 'PE', expiry, lotSize: 65 }];
  }
  async subscribe(symbols) {
    this.subscribed.push(...symbols.filter((s) => this.keys.has(s)));
  }
  async getTodayOptionCandles() {
    return this.candles;
  }
}

test('after a restart a held option is subscribed: its contract list is read first so the feed knows its key', async () => {
  const feed = new FakeFeed();
  const market = new MarketDataService(feed);
  await market.watchOption(SYMBOL);
  assert.equal(feed.listReads, 1);
  assert.deepEqual(feed.subscribed, [SYMBOL], 'without the list read the subscription would do nothing');
  assert.equal(market.lotSize(SYMBOL), 65);
});

test('an option with no tick is priced from a tick that arrives, else from its latest candle, else not at all', async () => {
  const feed = new FakeFeed({ candles: [{ time: 1, close: 80 }, { time: 2, close: 92.5 }] });
  const market = new MarketDataService(feed);
  assert.equal(await market.quoteOption(SYMBOL, 50), 92.5);

  const ticking = new FakeFeed();
  const live = new MarketDataService(ticking);
  setTimeout(() => ticking.emit('tick', { symbol: SYMBOL, ltp: 101 }), 20);
  assert.equal(await live.quoteOption(SYMBOL, 1000), 101);

  const silent = new MarketDataService(new FakeFeed());
  assert.equal(await silent.quoteOption(SYMBOL, 50), null);
});
