import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MarketDataService, FEED_STALE_MS } from '../src/market/MarketDataService.js';

const NIFTY = 'NIFTY 50';
// Wednesday 18 Nov 2026, 9:51 IST (market open) and 20:00 IST (closed)
const OPEN = new Date('2026-11-18T04:21:40Z');
const CLOSED = new Date('2026-11-18T14:30:00Z');

class Feed extends EventEmitter {
  get isSimulated() {
    return false;
  }
}

test('the feed counts as down when the market is open and the Nifty has sent no price for a while (18 Nov, 9:39 to 10:03)', () => {
  const market = new MarketDataService(new Feed());
  assert.equal(market.isStale(NIFTY, OPEN), true, 'no price ever: down');
  assert.match(market.staleReason(NIFTY, OPEN), /price feed is down.*open trades stay open/);

  market.tickAt.set(NIFTY, OPEN.getTime() - 5000);
  assert.equal(market.isStale(NIFTY, OPEN), false, 'a price 5 seconds ago: fine');
  assert.equal(market.staleReason(NIFTY, OPEN), null);

  market.tickAt.set(NIFTY, OPEN.getTime() - FEED_STALE_MS - 1000);
  assert.equal(market.isStale(NIFTY, OPEN), true);
  assert.match(market.staleReason(NIFTY, OPEN), /no Nifty price for 31 seconds/);
});

test('outside market hours no prices are expected, so the feed is never "down" then', () => {
  const market = new MarketDataService(new Feed());
  assert.equal(market.isStale(NIFTY, CLOSED), false);
  assert.equal(market.staleReason(NIFTY, CLOSED), null);
});

test('a price arriving is timed, and the status says when the feed is down', () => {
  const feed = new Feed();
  const market = new MarketDataService(feed);
  feed.emit('tick', { symbol: NIFTY, ltp: 25240 });
  assert.ok(market.priceAge(NIFTY) < 1000);
  assert.equal(typeof market.status().feed.stale, 'boolean');
});

test('the simulated feed is never "down"', () => {
  const sim = new EventEmitter();
  sim.isSimulated = true;
  const market = new MarketDataService(sim);
  assert.equal(market.isStale(NIFTY, OPEN), false);
});
