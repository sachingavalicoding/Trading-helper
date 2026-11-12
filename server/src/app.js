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
import { autoRoutes } from './routes/auto.js';
import { optionRoutes } from './routes/options.js';
import { newsRoutes } from './routes/news.js';
import { reviewRoutes } from './routes/review.js';
import { reportRoutes } from './routes/report.js';
import { studyRoutes } from './routes/study.js';
import { comboRoutes } from './routes/combos.js';
import { learnerRoutes } from './routes/learner.js';
import { LearnerService } from './learner/service.js';
import { ReviewService } from './review/service.js';
import { StudyService } from './study/service.js';
import { LabService } from './lab/service.js';
import { TradeReplayService } from './replay/service.js';
import { replayRoutes } from './routes/replay.js';
import { labRoutes } from './routes/lab.js';
import { HistorySync } from './market/historySync.js';
import { historyRoutes } from './routes/history.js';
import { tickRoutes } from './routes/ticks.js';
import { dayReplayRoutes } from './routes/dayReplay.js';
import { optionHistoryRoutes } from './routes/optionHistory.js';
import { keepSettingsInLive } from './dayreplay/keepSettings.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const DISCLAIMER = 'Paper trading for learning. Not investment advice.';

export function createApp({ market, engine, config, tracker, scanner, news, autoTrader, optionTrader, review = new ReviewService({ market, config }), study = new StudyService({ market, config }), learner = new LearnerService({ study, market, config }), lab = new LabService({ market, config }), replay = new TradeReplayService({ market, config }), history = new HistorySync({ market }), optionHistory = null, ticks = null, dayReplay = null }) {
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

  app.get('/api/health', (_req, res) => res.json({ ok: true, startingBalance: config.startingBalance, disclaimer: DISCLAIMER }));
  app.get('/api/market/status', (_req, res) => res.json({ ...market.status(), disclaimer: DISCLAIMER }));

  app.use('/api/auth', authRoutes(config));
  if (config.replay?.livePort) app.use(keepSettingsInLive({ livePort: config.replay.livePort })); // settings changed in a replay are kept in the live app too

  const auth = requireAuth(config.jwtSecret);
  app.use('/api/market', auth, marketRoutes({ market }));
  app.use('/api/signals', auth, signalRoutes({ market, tracker }));
  if (scanner) app.use('/api/scanner', auth, scannerRoutes({ scanner, config }));
  if (autoTrader) app.use('/api/auto', auth, autoRoutes({ autoTrader }));
  if (optionTrader) app.use('/api/options', auth, optionRoutes({ optionTrader }));
  if (news) app.use('/api/news', auth, newsRoutes({ news }));
  app.use('/api/review', auth, reviewRoutes({ review }));
  app.use('/api/study', auth, studyRoutes({ study }));
  app.use('/api/learner', auth, learnerRoutes({ learner }));
  app.use('/api/lab', auth, labRoutes({ lab }));
  app.use('/api/replay', auth, replayRoutes({ replay }));
  app.use('/api/combos', auth, comboRoutes());
  app.use('/api/history', auth, historyRoutes({ history }));
  if (optionHistory) app.use('/api/option-history', auth, optionHistoryRoutes({ optionHistory }));
  if (ticks) app.use('/api/ticks', auth, tickRoutes({ recorder: ticks }));
  if (dayReplay) app.use('/api/replay-day', auth, dayReplayRoutes(dayReplay));
  app.use('/api/report', auth, reportRoutes({ engine, market, review }));
  app.use('/api', auth, tradingRoutes({ engine, market, config }));

  if (config.nodeEnv !== 'production') app.use('/upstox', upstoxRoutes(config));

  app.use('/api', notFoundHandler);

  if (config.clientDist) {
    // Built files under /assets carry a content hash in their name, so they never change and can be
    // cached for good. Everything else (index.html, icon, manifest) must be checked every time,
    // otherwise a phone keeps an old page that asks for files a new build has deleted.
    app.use(
      express.static(config.clientDist, {
        index: false,
        setHeaders(res, filePath) {
          const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
          res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    // A missing built file is a plain 404, never the app page served as JavaScript.
    app.use('/assets', (req, res) => res.status(404).type('text/plain').set('Cache-Control', 'no-store').send('Not found'));
    // Any other page address belongs to the single-page app.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || /^\/(api|upstox|socket\.io)(\/|$)/.test(req.path) || path.extname(req.path)) return next();
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(config.clientDist, 'index.html'), { cacheControl: false });
    });
  }

  app.use(errorHandler);
  return app;
}
