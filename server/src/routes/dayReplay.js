import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { SPEEDS, allowedSpeeds } from '../dayreplay/manager.js';
import { validate } from '../middleware/validate.js';
import { checkItems, gatherCheckFacts, gatherWhyFacts, whyItems } from '../dayreplay/diagnose.js';
import { istParts } from '../market/marketHours.js';
import { DAY_CHOICES, DELAY_CHOICES, PARALLEL_CHOICES, SLIPPAGE_CHOICES } from '../dayreplay/ladder.js';

const startBody = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), speed: z.number().int().refine((s) => SPEEDS.includes(s)).default(1), seconds: z.boolean().default(false) });
const sideField = z.enum(['options', 'shares']).default('options');
const sideBody = z.object({ side: sideField });
const testBody = z.object({
  side: sideField,
  days: z.number().int().refine((d) => DAY_CHOICES.includes(d)),
  slippagePct: z.number().refine((x) => SLIPPAGE_CHOICES.includes(x)).default(0.5),
  fillDelaySec: z.number().int().refine((x) => DELAY_CHOICES.includes(x)).default(2),
  parallel: z.number().int().refine((x) => PARALLEL_CHOICES.includes(x)).default(2),
});
const controlBody = z.object({ speed: z.number().refine((s) => SPEEDS.includes(s)).optional(), paused: z.boolean().optional() });

const BOOT_ID = randomUUID(); // changes with every start of the process, so a page can tell a restarted replay from the old one

/** Replay a recorded day: the live server starts/stops a replay copy; the replay copy reports and controls its clock. */
export function dayReplayRoutes({ config, clock, manager, ladder = null, market, optionTrader, scanner, engine }) {
  const r = Router();
  const errOut = (res, next) => (err) => (err.status && err.status < 500 ? res.status(err.status).json({ error: { code: err.code || 'BAD_REQUEST', message: err.message } }) : next(err));

  // Replay test, step by step (dayreplay/ladder.js): your settings now, then each change Learn suggested, kept only if it beats the best so far.
  const needLadder = (res) => (ladder ? false : (res.status(400).json({ error: { code: 'IN_REPLAY', message: 'Run replay tests from the live app.' } }), true));
  const sideOf = (req) => (req.query.side === 'shares' ? 'shares' : 'options');
  r.get('/test', (req, res, next) => {
    if (needLadder(res)) return;
    ladder.view(req.userId, sideOf(req)).then((d) => res.json(d), errOut(res, next));
  });
  r.post('/test/start', validate(testBody), (req, res, next) => {
    if (needLadder(res)) return;
    ladder.start(req.userId, req.body).then((d) => res.json(d), errOut(res, next));
  });
  for (const action of ['stop', 'apply', 'undo']) {
    r.post(`/test/${action}`, validate(sideBody), (req, res, next) => {
      if (needLadder(res)) return;
      ladder[action](req.userId, req.body.side).then((d) => res.json(d), errOut(res, next));
    });
  }

  r.get('/status', (_req, res) => {
    if (config.replay) return res.json({ mode: 'replay', bootId: BOOT_ID, day: config.replay.day, livePort: config.replay.livePort, speeds: allowedSpeeds(config.replay.fast), ...clock.info() });
    res.json({ mode: 'live', speeds: allowedSpeeds(manager.fastOk), allSpeeds: SPEEDS, run: manager.status(), speedCheck: manager.speedCheck?.view() ?? null });
  });

  // What the chosen day lacks, before starting it.
  r.get('/check', async (req, res, next) => {
    try {
      const day = String(req.query.day || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: { code: 'BAD_DAY', message: 'day must be YYYY-MM-DD' } });
      res.json({ day, items: checkItems(await gatherCheckFacts({ day, userId: req.userId })) });
    } catch (err) {
      next(err);
    }
  });

  // Why the running replay has (not) bought, in plain words.
  r.get('/why', async (req, res, next) => {
    try {
      if (!config.replay) return res.status(400).json({ error: { code: 'NOT_REPLAY', message: 'Only a running replay can say why it has not traded.' } });
      res.json({ items: whyItems(await gatherWhyFacts({ market, optionTrader, scanner, engine, userId: req.userId, istParts, config })) });
    } catch (err) {
      next(err);
    }
  });

  r.get('/days', async (_req, res, next) => {
    try {
      res.json({ days: manager ? await manager.days() : [], speeds: allowedSpeeds(manager?.fastOk) });
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

  // Speed check: the chosen day at 200x and at 50x with your settings now, every trade compared; 100x and 200x open only when they match.
  const dayBody = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
  r.get('/speed-check', (_req, res) => {
    if (!manager?.speedCheck) return res.status(400).json({ error: { code: 'IN_REPLAY', message: 'Run the speed check from the live app.' } });
    res.json(manager.speedCheck.view());
  });
  r.post('/speed-check', validate(dayBody), (req, res, next) => {
    if (!manager?.speedCheck) return res.status(400).json({ error: { code: 'IN_REPLAY', message: 'Run the speed check from the live app.' } });
    manager.speedCheck.start(req.userId, req.body.day).then((d) => res.json(d), errOut(res, next));
  });
  r.post('/speed-check/stop', (_req, res) => {
    if (!manager?.speedCheck) return res.status(400).json({ error: { code: 'IN_REPLAY', message: 'Run the speed check from the live app.' } });
    res.json(manager.speedCheck.stop());
  });

  r.post('/stop', (_req, res) => {
    if (!manager) return res.status(400).json({ error: { code: 'IN_REPLAY', message: 'Stop it from the live app.' } });
    res.json({ run: manager.stop() });
  });

  // Reset, from inside a replay: ask the live server to start this same day again (it stops this copy and wipes the test account).
  r.post('/reset', (req, res) => {
    if (!config.replay) return res.status(400).json({ error: { code: 'NOT_REPLAY', message: 'Only a replay can be reset.' } });
    // The live app stops this very process before it starts the new copy, so answer first and let the request go on in the background.
    res.status(202).json({ ok: true, bootId: BOOT_ID });
    fetch(`http://127.0.0.1:${config.replay.livePort}/api/replay-day/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' },
      body: JSON.stringify({ day: config.replay.day, speed: clock.info().speed || 1 }),
    }).catch(() => {});
  });

  r.post('/control',validate(controlBody), (req, res) => {
    if (!clock) return res.status(400).json({ error: { code: 'NOT_REPLAY', message: 'Only a replay has a clock to control.' } });
    const { speed, paused } = req.body;
    if (speed && !allowedSpeeds(config.replay?.fast).includes(speed)) return res.status(400).json({ error: { code: 'SPEED_NOT_CHECKED', message: `${speed}x needs a passed speed check first (live app > Replay > Check 200x).` } });
    if (speed) clock.setSpeed(speed);
    if (paused === true) clock.pause();
    if (paused === false) clock.resume();
    res.json(clock.info());
  });

  return r;
}
