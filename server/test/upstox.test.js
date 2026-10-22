import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import protobuf from 'protobufjs';
import { parseFeed } from '../src/market/providers/upstox/UpstoxProvider.js';

const PROTO = path.resolve('src/market/providers/upstox/MarketDataFeedV3.proto');

test('decodes a protobuf full feed into a normalized tick', async () => {
  const root = await protobuf.load(PROTO);
  const FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
  const key = 'NSE_EQ|TESTKEY';
  const payload = {
    type: 1,
    currentTs: 1761100000000,
    feeds: {
      [key]: {
        fullFeed: {
          marketFF: {
            ltpc: { ltp: 1410.5, ltt: 1761100000000, ltq: 5, cp: 1400 },
            marketLevel: { bidAskQuote: [{ bidQ: 100, bidP: 1410.45, askQ: 80, askP: 1410.55 }, { bidQ: 50, bidP: 1410.4, askQ: 60, askP: 1410.6 }] },
            marketOHLC: { ohlc: [{ interval: '1d', open: 1402, high: 1415, low: 1398, close: 1410.5, vol: 123456, ts: 1761100000000 }] },
            atp: 1406.2,
            vtt: 123456,
            tbq: 50000,
            tsq: 42000,
          },
        },
      },
    },
  };
  const buf = FeedResponse.encode(FeedResponse.fromObject(payload)).finish();
  const msg = FeedResponse.toObject(FeedResponse.decode(buf), { longs: Number, enums: String });
  const tick = parseFeed('RELIANCE', msg.feeds[key], msg.currentTs);

  assert.equal(tick.ltp, 1410.5);
  assert.equal(tick.prevClose, 1400);
  assert.equal(tick.change, 10.5);
  assert.equal(tick.changePct, 0.75);
  assert.equal(tick.open, 1402);
  assert.equal(tick.volume, 123456);
  assert.equal(tick.atp, 1406.2);
  assert.equal(tick.totalBuyQty, 50000);
  assert.deepEqual(tick.depth.bids[0], { price: 1410.45, qty: 100 });
  assert.deepEqual(tick.depth.asks[1], { price: 1410.6, qty: 60 });
  assert.equal(tick.source, 'upstox');
});

test('index feeds have no depth', () => {
  const tick = parseFeed('NIFTY 50', { fullFeed: { indexFF: { ltpc: { ltp: 25100, cp: 25000 } } } });
  assert.equal(tick.ltp, 25100);
  assert.equal(tick.depth, null);
  assert.equal(tick.isIndex, true);
});
