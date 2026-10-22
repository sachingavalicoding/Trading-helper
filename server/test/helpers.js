import mongoose from 'mongoose';
import request from 'supertest';
import { MockProvider } from '../src/market/providers/MockProvider.js';
import { MarketDataService } from '../src/market/MarketDataService.js';
import { OrderEngine } from '../src/services/orderEngine.js';
import { createApp } from '../src/app.js';
import { SignalTracker } from '../src/signals/tracker.js';
import { ScannerService } from '../src/scanner/service.js';
import { NewsService } from '../src/news/service.js';

process.env.NODE_ENV = 'test';

export const MONGO_TEST_URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/nifty_paper_trader_test';

export const baseConfig = {
  nodeEnv: 'test',
  jwtSecret: 'test-secret-that-is-long-enough-for-hs256-signing',
  jwtExpiresIn: '1h',
  clientOrigin: ['http://localhost:5173'],
  provider: 'mock',
  enforceMarketHours: false,
  nseHolidays: [],
  startingBalance: 100000,
  misLeverage: 5,
  maxOrderQty: 100000,
};

export async function setup(overrides = {}, { now, fetchText = async () => '<rss></rss>' } = {}) {
  if (mongoose.connection.readyState !== 1) await mongoose.connect(MONGO_TEST_URI);
  await mongoose.connection.db.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  const config = { ...baseConfig, ...overrides };
  const provider = new MockProvider({ intervalMs: 10_000_000 }); // ticks only when a test calls setPrice
  const market = new MarketDataService(provider);
  const engine = new OrderEngine({ market, config, now });
  await engine.init();
  await market.start();
  const tracker = new SignalTracker({ market, now });
  await tracker.init();
  const scanner = new ScannerService({ market, config, now });
  await scanner.init();
  const news = new NewsService({ market, store: scanner.store, fetchText, now });
  scanner.news = news;
  const app = createApp({ market, engine, config, tracker, scanner, news });
  return { config, provider, market, engine, tracker, scanner, news, app };
}

export async function teardown(ctx) {
  ctx?.engine.stop();
  ctx?.tracker.stop();
  ctx?.scanner.stop();
  ctx?.news.stop();
  await ctx?.market.stop();
}

export async function closeDb() {
  await mongoose.disconnect();
}

let n = 0;
export async function registerUser(app) {
  n += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: `Trader ${n}`, email: `trader${n}-${Date.now()}@example.com`, password: 'password123' })
    .expect(201);
  return { token: res.body.token, user: res.body.user, auth: { Authorization: `Bearer ${res.body.token}` } };
}

// Wait for the engine's per-user queue to drain after a tick-driven fill.
export const settle = () => new Promise((r) => setTimeout(r, 150));
