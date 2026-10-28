import { Router } from 'express';
import { catalog, GROUPS } from '../combos/conditions.js';
import { MAX_CONDITIONS, DEFAULT_WINDOW } from '../combos/combos.js';

/** The checks a combination can be built from. They do not depend on the user, so the list is the same for everyone. */
export function comboRoutes() {
  const router = Router();
  const body = { groups: GROUPS, conditions: catalog(), maxConditions: MAX_CONDITIONS, defaultWindow: DEFAULT_WINDOW };
  router.get('/catalog', (_req, res) => res.json(body));
  return router;
}
