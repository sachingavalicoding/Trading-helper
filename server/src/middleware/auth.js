import jwt from 'jsonwebtoken';
import { unauthorized } from '../utils/errors.js';

export function signToken(userId, { secret, expiresIn }) {
  return jwt.sign({ sub: String(userId) }, secret, { expiresIn });
}

export function verifyToken(token, secret) {
  const payload = jwt.verify(token, secret);
  return payload.sub;
}

export function requireAuth(secret) {
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next(unauthorized());
    try {
      req.userId = verifyToken(token, secret);
      next();
    } catch {
      next(unauthorized('Session expired, please log in again'));
    }
  };
}
