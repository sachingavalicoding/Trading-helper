// Command-line alternative to visiting http://localhost:5000/upstox/login.
//   1. node scripts/upstox-token.js           -> prints the login URL; log in, copy ?code=... from the redirect
//   2. node scripts/upstox-token.js <code>    -> saves UPSTOX_ACCESS_TOKEN to .env
import 'dotenv/config';
import path from 'node:path';
import { upstoxLoginUrl, exchangeUpstoxCode, setEnvValue } from '../src/services/upstoxAuth.js';

const creds = { apiKey: process.env.UPSTOX_API_KEY, apiSecret: process.env.UPSTOX_API_SECRET, redirectUri: process.env.UPSTOX_REDIRECT_URI };
if (!creds.apiKey || !creds.apiSecret || !creds.redirectUri) {
  console.error('Set UPSTOX_API_KEY, UPSTOX_API_SECRET and UPSTOX_REDIRECT_URI in server/.env first.');
  process.exit(1);
}

const code = process.argv[2];
if (!code) {
  console.log(`Open this URL, log in, then run: npm run upstox:token -- <code from the redirect URL>\n\n${upstoxLoginUrl(creds)}`);
  process.exit(0);
}
const token = await exchangeUpstoxCode(code, creds);
await setEnvValue(path.resolve('.env'), 'UPSTOX_ACCESS_TOKEN', token);
console.log('Saved UPSTOX_ACCESS_TOKEN to .env');
