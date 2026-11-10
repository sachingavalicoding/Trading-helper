import { logger } from '../utils/logger.js';

// The settings routes: the options bot, the shares bot and the exit rules (stop, ladder, limits).
const SETTINGS_PATHS = ['/api/options', '/api/auto', '/api/trade-defaults'];

/**
 * In a replay copy, a change to the settings (combinations, how fast to buy and sell, limits, ladder, bot switches) is also saved in the live app,
 * so the replay and the live app always use the same settings. Without this the change only reached the replay's own test database, which is
 * copied fresh from the live one on every start and Reset, so a switched-off combination came back on and a deleted one came back.
 * Only "pause today" stays in the replay: it is a date, and the replay runs on another day.
 */
export function keepSettingsInLive({ livePort, fetchFn = fetch }) {
  return (req, res, next) => {
    const at = req.path.replace(/\/+$/, '');
    if (req.method !== 'PUT' || !SETTINGS_PATHS.includes(at) || !req.body || typeof req.body !== 'object') return next();
    const { pauseToday, ...body } = req.body;
    if (!Object.keys(body).length) return next();
    const auth = req.headers.authorization || '';
    res.on('finish', () => {
      if (res.statusCode >= 300) return;
      fetchFn(`http://127.0.0.1:${livePort}${at}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body) })
        .then((out) => out.ok || logger.warn(`could not save the settings in the live app (${out.status})`))
        .catch((e) => logger.warn(`could not reach the live app to save the settings: ${e.message}`));
    });
    next();
  };
}
