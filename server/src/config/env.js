import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

// The finished web app. `phone-app/` is a prebuilt copy kept in the repo so a phone does not have to build it.
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = [path.resolve(here, '../../../phone-app'), path.resolve(here, '../../../client/dist')].find((d) => existsSync(path.join(d, 'index.html'))) || null;

const provider = (process.env.MARKET_DATA_PROVIDER || 'mock').toLowerCase();

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
  // Live providers enforce NSE hours for orders by default; the mock feed lets you practise any time.
  enforceMarketHours: bool(process.env.ENFORCE_MARKET_HOURS, provider !== 'mock'),
  // Comma separated YYYY-MM-DD dates when NSE is closed. Keep this in sync with NSE's holiday circular.
  nseHolidays: (process.env.NSE_HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Free headline feeds (Google News RSS). Turn off if the server cannot reach the internet.
  newsEnabled: bool(process.env.NEWS_ENABLED, true),

  startingBalance: num(process.env.STARTING_BALANCE, 100000),
  misLeverage: num(process.env.MIS_LEVERAGE, 5),
  maxOrderQty: num(process.env.MAX_ORDER_QTY, 100000),

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
