import http from 'node:http';
import { env, assertEnv } from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createProvider } from './market/providers/index.js';
import { MarketDataService } from './market/MarketDataService.js';
import { OrderEngine } from './services/orderEngine.js';
import { createApp } from './app.js';
import { SignalTracker } from './signals/tracker.js';
import { ScannerService } from './scanner/service.js';
import { AutoTrader } from './auto/autoTrader.js';
import { OptionTrader } from './options/optionTrader.js';
import { NewsService } from './news/service.js';
import { HistorySync } from './market/historySync.js';
import { OptionHistorySync } from './market/optionHistory.js';
import path from 'node:path';
import { YearFiles, YearDownload, TempImports } from './archive/yearFiles.js';
import { OptionArchive } from './archive/optionArchive.js';
import { Mailer } from './archive/mailer.js';
import { TickRecorder } from './ticks/tickRecorder.js';
import { attachSocket } from './socket/index.js';
import { prepareReplay } from './dayreplay/boot.js';
import { mongoSettingsSync } from './dayreplay/settingsLink.js';
import { dayReplayRoutesDeps } from './dayreplay/manager.js';
import { finishWhenDone } from './dayreplay/result.js';
import { ReplayLadder } from './dayreplay/ladder.js';
import { TestRunner } from './dayreplay/testRunner.js';
import { StudyService } from './study/service.js';
import { LearnerService } from './learner/service.js';
import { LearnService } from './learner/learnService.js';
import { LabService } from './lab/service.js';
import { logger } from './utils/logger.js';

async function main() {
  assertEnv();
  // A replay run uses its own database and a virtual clock; the live server never does.
  const replay = env.replay ? await prepareReplay(env) : null;
  await connectDb(replay ? replay.mongoUri : env.mongoUri);
  // a replay follows the live settings all the time (see dayreplay/settingsLink.js); a test run keeps its own copy and never reads them
  const settingsSync = replay && !env.replay.test ? await mongoSettingsSync({ sourceUri: replay.sourceUri }) : null;
  if (settingsSync) {
    await settingsSync.syncNow();
    settingsSync.start();
  }

  const market = new MarketDataService(replay ? replay.provider : createProvider(env), { holidays: env.nseHolidays, expiryWeekday: env.niftyExpiryWeekday, enforceHours: env.enforceMarketHours });
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
  const tracker = new SignalTracker({ market });
  await tracker.init();
  const scanner = new ScannerService({ market, config: env });
  await scanner.init();
  const news = new NewsService({ market, store: scanner.store });
  scanner.news = news;
  if (env.newsEnabled) news.start();
  scanner.start();
  const autoTrader = new AutoTrader({ scanner, engine, config: env });
  autoTrader.start();
  const optionTrader = new OptionTrader({ market, engine, config: env, scanner });
  await optionTrader.init();
  optionTrader.start();

  const history = new HistorySync({ market });
  const optionHistory = new OptionHistorySync({ market });
  const yearFiles = new YearFiles({ dir: path.join(env.archiveDir, 'years') });
  const mailer = new Mailer(env.mail);
  const archive = {
    yearFiles,
    yearDownload: new YearDownload({ market, files: yearFiles }),
    imports: new TempImports({ dir: path.join(env.archiveDir, 'temp') }),
    optionArchive: new OptionArchive({ dir: path.join(env.archiveDir, 'options'), mailer }),
    mailer,
  };
  if (!replay) {
    history.schedule();
    optionHistory.schedule();
    archive.imports.schedule();
    archive.optionArchive.schedule();
  }
  const ticks = new TickRecorder({ market, config: env });
  ticks.start();
  const dayReplay = dayReplayRoutesDeps({ config: env, clock: replay?.clock ?? null, market, optionTrader, scanner, engine });
  const study = new StudyService({ market, config: env });
  const learner = new LearnerService({ study, market, config: env });
  if (!replay) learner.schedule(); // each trading evening, for users who switched auto on
  const lab = new LabService({ market, config: env });
  const learn = new LearnService({ lab, market, study, config: env });
  if (!replay) learn.schedule(); // Learn's evening run, for users who switched it on
  if (dayReplay.manager) {
    // replay tests of Learn's changes; up to 4 days play side by side, each copy on its own port and database
    dayReplay.ladder = new ReplayLadder({ runners: [0, 1, 2, 3].map((slot) => new TestRunner({ config: env, slot })), learn });
    process.on('exit', () => dayReplay.ladder.runners.forEach((r) => r.child?.kill()));
  }
  const app = createApp({ market, engine, config: env, tracker, scanner, news, autoTrader, optionTrader, history, optionHistory, archive, ticks, dayReplay, study, learner, lab, learn });
  const server = http.createServer(app);
  const io = attachSocket(server, { market, engine, config: env, scanner });

  server.listen(env.port, () => {
    const feed = market.status().feed;
    logger.info(`API on http://localhost:${env.port} | feed: ${feed.provider}${feed.simulated ? ' (SIMULATED)' : ''} | market hours enforced: ${env.enforceMarketHours}`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    dayReplay.manager?.stop();
    dayReplay.ladder?.runners.forEach((r) => r.stop());
    settingsSync?.stop();
    engine.stop();
    tracker.stop();
    autoTrader.stop();
    optionTrader.stop();
    history.stop();
    optionHistory.stop();
    archive.imports.stop();
    archive.optionArchive.stop();
    learner.stop();
    learn.stop();
    await ticks.stop();
    scanner.stop();
    news.stop();
    io.closeAll();
    await market.stop();
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  if (replay && env.replay.test && env.replay.resultFile) finishWhenDone({ clock: replay.clock, day: env.replay.day, file: env.replay.resultFile, stop: shutdown });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Failed to start:', err.message);
  process.exit(1);
});
