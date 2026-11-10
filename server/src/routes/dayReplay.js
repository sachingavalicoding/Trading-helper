import { Router } from 'express';
import { z } from 'zod';
import { SPEEDS } from '../dayreplay/manager.js';
import { validate } from '../middleware/validate.js';

const startBody = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), speed: z.number().int().refine((s) => SPEEDS.includes(s)).default(1) });
const controlBody = z.object({ speed: z.number().refine((s) => SPEEDS.includes(s)).optional(), paused: z.boolean().optional() });

/** Replay a recorded day: the live server starts/stops a replay copy; the replay copy reports and controls its clock. */
export function dayReplayRoutes({ config, clock, manager }) {
  const r = Router();

  r.get('/status', (_req, res) => {
    if (config.replay) return res.json({ mode: 'replay', day: config.replay.day, livePort: config.replay.livePort, speeds: SPEEDS, ...clock.info() });
    res.json({ mode: 'live', speeds: SPEEDS, run: manager.status() });
  });

  r.get('/days', async (_req, res, next) => {
    try {
      res.json({ days: manager ? await manager.days() : [], speeds: SPEEDS });
    } catch (err) {
      next(err);
    }
  });

  r.post('/start', validate(startBody), async (req, res, next) => {
    try {
      if (!manager) return res.status(400).json({ error: { code: 'IN_REPLAY', message: 'This is already a replay. Go back to the live app to start another.' } });
      res.json({ run: await manager.start(req.body) });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
      next(err);
    }
  });

  r.post('/stop', (_req, res) => {
    if (!manager) return res.status(400).json({ error: { code: 'IN_REPLAY', message: 'Stop it from the live app.' } });
    res.json({ run: manager.stop() });
  });

  r.post('/control', validate(controlBody), (req, res) => {
    if (!clock) return res.status(400).json({ error: { code: 'NOT_REPLAY', message: 'Only a replay has a clock to control.' } });
    const { speed, paused } = req.body;
    if (speed) clock.setSpeed(speed);
    if (paused === true) clock.pause();
    if (paused === false) clock.resume();
    res.json(clock.info());
  });

  return r;
}
