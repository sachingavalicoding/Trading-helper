import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

// The finished web app. `phone-app/` is a prebuilt copy kept in the repo so a phone does not have to build it.
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = [path.resolve(here, '../../../phone-app'), path.resolve(here, '../../../client/dist')].find((d) => existsSync(path.join(d, 'index.html'))) || null;

// A replay run (see dayreplay/) is the same server started on a past day's recorded data: REPLAY_DAY=YYYY-MM-DD.
const replayDay = /^\d{4}-\d{2}-\d{2}$/.test(process.env.REPLAY_DAY || '') ? process.env.REPLAY_DAY : '';
const provider = replayDay ? 'replay' : (process.env.MARKET_DATA_PROVIDER || 'mock').toLowerCase();

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 5000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/nifty_paper_trader',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientOrigin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),

  // Serve the web app from this server too (one process, one address). Turn off with SERVE_CLIENT=false.
  clientDist: bool(process.env.SERVE_CLIENT, true) ? clientDist : null,

  provider,
  replay: replayDay
    ? {
        day: replayDay,
        speed: num(process.env.REPLAY_SPEED, 1),
        sourceMongoUri: process.env.REPLAY_SOURCE_MONGO_URI || '',
        livePort: num(process.env.REPLAY_LIVE_PORT, 0),
        fast: bool(process.env.REPLAY_FAST, false), // 100x and 200x may be picked (a speed check found the same trades as 50x)
        seconds: bool(process.env.REPLAY_SECONDS, false), // play the recorded seconds where they exist (default: 1-minute candles for everything)
        // A test run (dayreplay/ladder.js): own settings from REPLAY_SETTINGS_FILE, never linked to the live settings, writes its result to
        // REPLAY_RESULT_FILE and exits when the day is over.
        test: bool(process.env.REPLAY_TEST, false),
        settingsFile: process.env.REPLAY_SETTINGS_FILE || '',
        resultFile: process.env.REPLAY_RESULT_FILE || '',
        slot: num(process.env.REPLAY_TEST_SLOT, 0), // which of the side-by-side test copies this is (its own database)
      }
    : null,
  // Fills made worse than the price seen, so a replay is not rosier than a live day: a market order fills `fillDelaySec` seconds later,
  // `slippagePct` % worse (a buy higher, a sell lower). Only a replay uses them.
  fill: replayDay ? { slippagePct: num(process.env.REPLAY_SLIPPAGE_PCT, 0), delaySec: num(process.env.REPLAY_FILL_DELAY_SEC, 0) } : { slippagePct: 0, delaySec: 0 },
  replayPort: num(process.env.REPLAY_PORT, 0), // the port a replay run listens on (default: this server's port + 1)
  // Live providers enforce NSE hours for orders by default; the mock feed lets you practise any time.
  enforceMarketHours: bool(process.env.ENFORCE_MARKET_HOURS, provider !== 'mock'),
  // Comma separated YYYY-MM-DD dates when NSE is closed. Keep this in sync with NSE's holiday circular.
  nseHolidays: (process.env.NSE_HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Free headline feeds (Google News RSS). Turn off if the server cannot reach the internet.
  newsEnabled: replayDay ? false : bool(process.env.NEWS_ENABLED, true),

  // One-second record of Nifty and the streaming option contracts (the newest 3 days are kept). Turn off with TICK_RECORD=false.
  tickRecord: replayDay ? false : bool(process.env.TICK_RECORD, true),

  // Year files of candles, monthly option data files and temporary imports are kept under this folder (never in the database).
  archiveDir: process.env.ARCHIVE_DIR || path.resolve(here, '../../data'),
  // Mail for the monthly option data (a Gmail app password works). Without SMTP_USER and SMTP_PASS nothing is sent; the files can still be downloaded.
  mail: { host: process.env.SMTP_HOST || 'smtp.gmail.com', port: num(process.env.SMTP_PORT, 465), user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '', from: process.env.SMTP_FROM || '' },

  startingBalance: num(process.env.STARTING_BALANCE, 100000),
  misLeverage: num(process.env.MIS_LEVERAGE, 5),
  maxOrderQty: num(process.env.MAX_ORDER_QTY, 100000),
  // Nifty options: contracts per lot (the live feed's own lot size wins when it lists one) and the weekly expiry weekday (2 = Tuesday).
  niftyLotSize: num(process.env.NIFTY_LOT_SIZE, 65),
  niftyExpiryWeekday: num(process.env.NIFTY_EXPIRY_WEEKDAY, 2),

  upstox: {
    accessToken: process.env.UPSTOX_ACCESS_TOKEN || '',
    apiKey: process.env.UPSTOX_API_KEY || '',
    apiSecret: process.env.UPSTOX_API_SECRET || '',
    redirectUri: process.env.UPSTOX_REDIRECT_URI || '',
    apiBase: process.env.UPSTOX_API_BASE || 'https://api.upstox.com',
    // Optional JSON file mapping SYMBOL -> instrument_key (e.g. "RELIANCE": "NSE_EQ|INE002A01018").
    instrumentMapFile: process.env.UPSTOX_INSTRUMENT_MAP_FILE || '',
  },
};

export function assertEnv() {
  if (!env.jwtSecret || env.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set to a random string of at least 32 characters (see .env.example)');
  }
}
