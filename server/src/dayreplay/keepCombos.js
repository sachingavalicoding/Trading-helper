import { logger } from '../utils/logger.js';

// The settings routes whose combination list should outlive a replay.
const COMBO_PATHS = ['/api/options', '/api/auto'];

/**
 * In a replay copy, a change to "My combinations" (switch on/off, edit, delete, add) is also saved in the live app.
 * Without this the change only reached the replay's test database, which is copied fresh from the live one on every start and Reset,
 * so a switched-off combination came back on and a deleted one came back. Only the combination list is passed on: other settings
 * changed in a replay (the bot switch, "pause today") stay in the replay.
 */
export function keepCombosInLive({ livePort, fetchFn = fetch }) {
  return (req, res, next) => {
    const combos = req.body?.combos;
    const at = req.path.replace(/\/+$/, '');
    if (req.method !== 'PUT' || !COMBO_PATHS.includes(at) || !Array.isArray(combos)) return next();
    const auth = req.headers.authorization || '';
    res.on('finish', () => {
      if (res.statusCode >= 300) return;
      fetchFn(`http://127.0.0.1:${livePort}${at}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ combos }) })
        .then((out) => out.ok || logger.warn(`could not save the combinations in the live app (${out.status})`))
        .catch((e) => logger.warn(`could not reach the live app to save the combinations: ${e.message}`));
    });
    next();
  };
}
