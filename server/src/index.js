import http from 'node:http';
import { env, assertEnv } from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createProvider } from './market/providers/index.js';
import { MarketDataService } from './market/MarketDataService.js';
import { OrderEngine } from './services/orderEngine.js';
import { createApp } from './app.js';
import { attachSocket } from './socket/index.js';
import { logger } from './utils/logger.js';

async function main() {
  assertEnv();
  await connectDb(env.mongoUri);

  const market = new MarketDataService(createProvider(env), { holidays: env.nseHolidays });
  const engine = new OrderEngine({ market, config: env });
  await engine.init();
  try {
    await market.start();
  } catch (err) {
    // Keep the server up (so /upstox/login works) and show the feed as offline in the UI.
    const hint = env.provider === 'upstox' ? ` Log in at http://localhost:${env.port}/upstox/login` : '';
    logger.error(`Market data feed failed to start: ${err.message}.${hint}`);
    market.provider.setStatus(false, `Feed offline: ${err.message}`);
  }
  engine.startScheduler();

  const app = createApp({ market, engine, config: env });
  const server = http.createServer(app);
  const io = attachSocket(server, { market, engine, config: env });

  server.listen(env.port, () => {
    const feed = market.status().feed;
    logger.info(`API on http://localhost:${env.port} | feed: ${feed.provider}${feed.simulated ? ' (SIMULATED)' : ''} | market hours enforced: ${env.enforceMarketHours}`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    engine.stop();
    io.closeAll();
    await market.stop();
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Failed to start:', err.message);
  process.exit(1);
});
