import { z } from 'zod';

// A profit ladder is a list of rungs [profit, kept]: once the profit reaches a rung the stop keeps that rung's `keep`, then
// follows (at - keep) behind the best profit until the next rung. Shares use percent of the money put in, options use rupees per lot.
// An empty list from the user means "use the built-in ladder".

export const ladderSchema = (maxAt) =>
  z
    .array(z.object({ at: z.coerce.number().positive().max(maxAt), keep: z.coerce.number().positive().max(maxAt) }))
    .max(8)
    .superRefine((rows, ctx) => {
      rows.forEach((r, i) => {
        if (!(r.at > r.keep)) ctx.addIssue({ code: 'custom', message: `Rung ${i + 1}: the profit that starts the lock must be larger than the profit it keeps` });
        else if (i > 0 && !(r.at > rows[i - 1].at && r.keep > rows[i - 1].keep)) ctx.addIssue({ code: 'custom', message: `Rung ${i + 1}: both numbers must be larger than the rung above` });
      });
    });

/** The ladder to use: the user's own rungs as [at, keep] pairs, or the built-in ones. */
export const effectiveLadder = (custom, builtIn) => (custom?.length ? custom.map(({ at, keep }) => [at, keep]) : builtIn);

/** The same pairs as the objects the API returns. */
export const ladderRows = (pairs) => pairs.map(([at, keep]) => ({ at, keep }));
