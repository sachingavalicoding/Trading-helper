import express from 'express';
import path from 'node:path';
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
import { newsRoutes } from './routes/news.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const DISCLAIMER = 'Paper trading for learning. Not investment advice.';

export function createApp({ market, engine, config, tracker, scanner, news }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // The built web app has one small inline script (it sets the dark theme before the page paints), which helmet's
  // default content policy would block, so the policy is switched off only when this server also serves the app.
  app.use(helmet(config.clientDist ? { contentSecurityPolicy: false } : {}));
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
  if (news) app.use('/api/news', auth, newsRoutes({ news }));
  app.use('/api', auth, tradingRoutes({ engine, market, config }));

  if (config.nodeEnv !== 'production') app.use('/upstox', upstoxRoutes(config));

  app.use('/api', notFoundHandler);

  if (config.clientDist) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    // Any other page address belongs to the single-page app.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || /^\/(api|upstox|socket\.io)(\/|$)/.test(req.path) || path.extname(req.path)) return next();
      res.sendFile(path.join(config.clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
