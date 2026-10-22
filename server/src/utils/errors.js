export class AppError extends Error {
  constructor(status, message, code = 'ERROR', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, code = 'BAD_REQUEST', details) => new AppError(400, msg, code, details);
export const unauthorized = (msg = 'Not authenticated') => new AppError(401, msg, 'UNAUTHORIZED');
export const notFound = (msg = 'Not found') => new AppError(404, msg, 'NOT_FOUND');
export const conflict = (msg, code = 'CONFLICT') => new AppError(409, msg, code);
export const unavailable = (msg, code = 'UNAVAILABLE') => new AppError(503, msg, code);
