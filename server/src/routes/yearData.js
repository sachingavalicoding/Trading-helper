import { Router } from 'express';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { badRequest } from '../utils/errors.js';
import { MAX_IMPORT_BYTES, GROUPS } from '../archive/yearFiles.js';
import { isDay } from '../market/days.js';
import { pipeline } from 'node:stream/promises';

const downloadSchema = z.object({ months: z.coerce.number().int().min(1).max(60).default(12) });
const recipientSchema = z.object({ to: z.string().trim().email().max(120) });
const sendSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), email: z.boolean().default(true) });

export const YEAR_NOTE = 'Real Upstox 1-minute candles, one compressed file per year (Nifty, and the 50 shares), saved on the server, never in the database. Download a file to keep it on your phone or laptop, and Import it later for a test: an imported file lives in a temporary folder and deletes itself a day after its last use.';

export function yearDataRoutes({ yearDownload, yearFiles, imports, optionArchive, mailer }) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({
      note: YEAR_NOTE,
      simulated: Boolean(yearDownload.market.provider.isSimulated),
      job: yearDownload.status(),
      files: await yearFiles.list(),
      imports: await imports.list(),
      groups: Object.values(GROUPS).map((g) => ({ key: g.key, label: g.label, symbols: g.symbols.length })),
    });
  });

  router.post('/download', validate(downloadSchema), (req, res) => {
    yearDownload.start({ months: req.body.months });
    res.status(202).json({ job: yearDownload.status() });
  });

  router.get('/files/:name', (req, res, next) => {
    let file;
    try {
      file = yearFiles.pathOf(req.params.name);
    } catch (e) {
      return next(e);
    }
    res.download(file, req.params.name, (err) => err && !res.headersSent && next(badRequest('No such file', 'NOT_FOUND')));
  });

  // Import: the file's bytes are the request body (not JSON), written straight to a temporary file so a big year never sits in memory.
  router.post('/import', async (req, res, next) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_IMPORT_BYTES) return next(badRequest('That file is too big to import'));
    const { id, partPath } = await imports.begin();
    try {
      let bytes = 0;
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_IMPORT_BYTES) req.destroy(new Error('too big'));
      });
      await pipeline(req, createWriteStream(partPath));
      res.status(201).json({ import: await imports.finish(id, partPath, String(req.query.name || '')) });
    } catch (e) {
      await rm(partPath, { force: true });
      next(e.status ? e : badRequest('The upload did not finish'));
    }
  });

  router.delete('/imports/:id', async (req, res) => {
    await imports.remove(req.params.id);
    res.json({ ok: true });
  });

  router.get('/imports/:id/candles', async (req, res) => {
    const { symbol, from, to } = req.query;
    if (!symbol || !isDay(String(from)) || !isDay(String(to))) throw badRequest('Give symbol, from and to (YYYY-MM-DD)');
    res.json({ symbol, candles: await imports.candles(req.params.id, String(symbol), String(from), String(to)) });
  });

  // Monthly option contract data
  router.get('/options', async (_req, res) => {
    res.json({ months: await optionArchive.months(), job: optionArchive.status(), recipient: (await optionArchive.state.get()).recipient, mailReady: mailer.enabled });
  });

  router.put('/options/recipient', validate(recipientSchema), async (req, res) => {
    await optionArchive.state.setRecipient(req.body.to);
    res.json({ recipient: req.body.to });
  });

  router.post('/options/send', validate(sendSchema), (req, res) => {
    optionArchive.start(req.body.month, { email: req.body.email });
    res.status(202).json({ job: optionArchive.status() });
  });

  router.get('/options/files/:name', (req, res, next) => {
    let file;
    try {
      file = optionArchive.pathOf(req.params.name);
    } catch (e) {
      return next(e);
    }
    res.download(file, req.params.name, (err) => err && !res.headersSent && next(badRequest('No such file', 'NOT_FOUND')));
  });

  return router;
}
