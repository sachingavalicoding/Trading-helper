import { badRequest } from '../utils/errors.js';

// Parses req[source] with a zod schema and replaces it with the parsed value.
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    return next(badRequest(field ? `${field}: ${issue.message}` : issue.message, 'VALIDATION', result.error.issues));
  }
  if (source === 'body') req.body = result.data;
  else req.valid = result.data;
  next();
};
