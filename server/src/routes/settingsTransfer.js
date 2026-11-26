import express, { Router } from 'express';
import { exportSettings, previewImport, applyImport, ImportError } from '../settings/transfer.js';
import { badRequest } from '../utils/errors.js';

// More > Settings > Copy settings: GET /export (the file), POST /preview { file } (what would change), PUT / { file, confirm: true } (replace).
// A file with many combinations is bigger than the app's normal 50 kB body limit, so these routes read up to 1 MB themselves.
export const SETTINGS_FILE_LIMIT = '1mb';
export const settingsBody = express.json({ limit: SETTINGS_FILE_LIMIT });

export function settingsTransferRoutes() {
  const router = Router();
  const fail = (e, next) => (e instanceof ImportError ? next(badRequest(e.message, 'BAD_SETTINGS_FILE')) : next(e));

  router.get('/export', async (req, res) => {
    const file = await exportSettings(req.userId);
    const day = file.exportedAt.slice(0, 10);
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="trade-helper-settings-${day}.json"`);
    res.json(file);
  });

  router.post('/preview', async (req, res, next) => {
    try {
      res.json(await previewImport(req.userId, req.body?.file));
    } catch (e) {
      fail(e, next);
    }
  });

  router.put('/', async (req, res, next) => {
    if (req.body?.confirm !== true) return next(badRequest('Confirm the import first.', 'CONFIRM_NEEDED'));
    try {
      res.json(await applyImport(req.userId, req.body.file));
    } catch (e) {
      fail(e, next);
    }
  });
  return router;
}
