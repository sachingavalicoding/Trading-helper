import { Router } from 'express';
import path from 'node:path';
import { upstoxLoginUrl, exchangeUpstoxCode, setEnvValue } from '../services/upstoxAuth.js';
import { logger } from '../utils/logger.js';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0b0f17;color:#e6ebf5;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px;text-align:center}a{color:#3b82f6}</style></head><body><main>${body}</main></body></html>`;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Only the machine running the server may use the Upstox login pages, never another device on the Wi-Fi. */
export function loopbackOnly(req, res, next) {
  if (LOOPBACK.has(req.socket?.remoteAddress)) return next();
  res.status(403).send(page('Not allowed', '<h2>The Upstox login can only be opened on the device that runs the server.</h2>'));
}

/**
 * Local-development helper for the daily Upstox login:
 *   GET /upstox/login     -> redirects to Upstox
 *   GET /upstox/callback  -> exchanges the code and saves UPSTOX_ACCESS_TOKEN to server/.env
 * nodemon watches .env, so the server restarts with the new token automatically.
 * Disabled in production, where the token should come from the host's secret settings.
 */
export function upstoxRoutes(config) {
  const router = Router();
  const creds = config.upstox;
  router.use(loopbackOnly);

  router.get('/login', (_req, res) => {
    if (!creds.apiKey || !creds.redirectUri) {
      return res.status(400).send(page('Upstox not configured', '<h2>Add UPSTOX_API_KEY, UPSTOX_API_SECRET and UPSTOX_REDIRECT_URI to server/.env first.</h2>'));
    }
    res.redirect(upstoxLoginUrl(creds));
  });

  router.get('/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return res.status(400).send(page('Upstox login', '<h2>No code received from Upstox.</h2><p><a href="/upstox/login">Try again</a></p>'));
    try {
      const token = await exchangeUpstoxCode(code, creds);
      await setEnvValue(path.resolve('.env'), 'UPSTOX_ACCESS_TOKEN', token);
      logger.info('Upstox access token saved to .env');
      res.send(page('Upstox connected', `<h2>✅ Upstox connected</h2><p>Token saved. The server restarts with live prices in a few seconds.</p><p><a href="${config.clientOrigin[0]}">Open the app</a></p>`));
    } catch (err) {
      logger.error(err.message);
      res.status(502).send(page('Upstox login failed', `<h2>Login failed</h2><p>${err.message.replace(/[<>&]/g, '')}</p><p><a href="/upstox/login">Try again</a></p>`));
    }
  });

  return router;
}
