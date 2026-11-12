import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { notFound } from '../utils/errors.js';
import { KINDS } from '../learner/service.js';

export const LEARNER_NOTE = 'The learner tries combinations on the saved days: it picks on the older two thirds and only keeps a pick that also made money, after charges, on the newest third it never saw, and did better there than your current combinations. With auto on it changes your paper trading only. Past results do not promise future ones, and most evenings it may find nothing.';

/** The auto-learner card: GET the card, POST /run, PUT /auto { on }, POST /use (the last pick, by hand), POST /undo. */
export function learnerRoutes({ learner }) {
  const router = Router();
  router.param('kind', (req, _res, next, kind) => (KINDS.includes(kind) ? next() : next(notFound('No such learner'))));

  router.get('/:kind', async (req, res) => res.json({ ...(await learner.view(req.userId, req.params.kind)), note: LEARNER_NOTE }));

  router.post('/:kind/run', (req, res) => {
    const job = learner.start(req.userId, req.params.kind);
    res.status(202).json({ status: { state: job.state, step: job.step } });
  });

  router.put('/:kind/auto', validate(z.object({ on: z.boolean() })), async (req, res) => res.json(await learner.setAuto(req.userId, req.params.kind, req.body.on)));
  router.post('/:kind/use', async (req, res) => res.json(await learner.use(req.userId, req.params.kind)));
  router.post('/:kind/undo', async (req, res) => res.json(await learner.undo(req.userId, req.params.kind)));
  return router;
}
