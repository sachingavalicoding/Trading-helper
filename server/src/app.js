import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { authRoutes } from './routes/auth.js';
import { marketRoutes } from './routes/market.js';
import { tradingRoutes } from './routes/trading.js';
import { upstoxRoutes } from './routes/upstox.js';
import { signalRoutes } from './routes/signals.js';
import { scannerRoutes } from './routes/scanner.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const DISCLAIMER = 'Paper trading for learning. Not investment advice.';

export function createApp({ market, engine, config, tracker, scanner }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '50kb' }));
  if (config.nodeEnv === 'development') app.use(morgan('dev'));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: config.nodeEnv === 'test' ? 10000 : 300, standardHeaders: 'draft-7', legacyHeaders: false }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, disclaimer: DISCLAIMER }));
  app.get('/api/market/status', (_req, res) => res.json({ ...market.status(), disclaimer: DISCLAIMER }));

  app.use('/api/auth', authRoutes(config));

  const auth = requireAuth(config.jwtSecret);
  app.use('/api/market', auth, marketRoutes({ market }));
  app.use('/api/signals', auth, signalRoutes({ market, tracker }));
  if (scanner) app.use('/api/scanner', auth, scannerRoutes({ scanner, config }));
  app.use('/api', auth, tradingRoutes({ engine, market, config }));

  if (config.nodeEnv !== 'production') app.use('/upstox', upstoxRoutes(config));

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
