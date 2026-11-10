import { logger } from '../utils/logger.js';

// The settings routes: the options bot, the shares bot and the exit rules (stop, ladder, limits).
const SETTINGS_PATHS = ['/api/options', '/api/auto', '/api/trade-defaults'];

/**
 * In a replay copy, a change to the settings (combinations, how fast to buy and sell, limits, ladder, bot switches) is also saved in the live app,
 * so the replay and the live app always use the same settings (the live app is written first). Without this the change only reached the replay's own test database, which is
 * copied fresh from the live one on every start and Reset, so a switched-off combination came back on and a deleted one came back.
 * Only "pause today" stays in the replay: it is a date, and the replay runs on another day.
 */
export function keepSettingsInLive({ livePort, fetchFn = fetch }) {
  return async (req, res, next) => {
    const at = req.path.replace(/\/+$/, '');
    if (req.method !== 'PUT' || !SETTINGS_PATHS.includes(at) || !req.body || typeof req.body !== 'object') return next();
    const { pauseToday, ...body } = req.body;
    if (!Object.keys(body).length) return next();
    // The live app saves first. If it cannot, the change is refused here too: saving it only in the replay would let the replay's next
    // settings sync (or a Reset) bring the old value back without a word.
    try {
      const out = await fetchFn(`http://127.0.0.1:${livePort}${at}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' }, body: JSON.stringify(body) });
      if (out.ok) return next();
      const data = await out.json?.().catch(() => null);
      logger.warn(`the live app refused the setting (${out.status})`);
      return res.status(out.status >= 400 && out.status < 500 ? out.status : 502).json(data?.error ? data : { error: { code: 'LIVE_SAVE_FAILED', message: `The live app could not save this setting (${out.status}), so it was not changed.` } });
    } catch (e) {
      logger.warn(`could not reach the live app to save the settings: ${e.message}`);
      return res.status(502).json({ error: { code: 'LIVE_SAVE_FAILED', message: 'Could not reach the live app to save this setting, so it was not changed. Is the live app still running?' } });
    }
  };
}
