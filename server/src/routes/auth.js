import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { getOrCreateWallet } from '../services/walletService.js';
import { conflict, unauthorized, notFound } from '../utils/errors.js';

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'must be at least 8 characters').max(128),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export function authRoutes(config) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.nodeEnv === 'test' ? 1000 : 20, standardHeaders: 'draft-7', legacyHeaders: false });
  const tokenFor = (user) => signToken(user._id, { secret: config.jwtSecret, expiresIn: config.jwtExpiresIn });

  router.post('/register', limiter, validate(registerSchema), async (req, res) => {
    const { name, email, password } = req.body;
    if (await User.exists({ email })) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 10) });
    await getOrCreateWallet(user._id, config.startingBalance);
    res.status(201).json({ token: tokenFor(user), user });
  });

  router.post('/login', limiter, validate(loginSchema), async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw unauthorized('Wrong email or password');
    res.json({ token: tokenFor(user), user });
  });

  router.get('/me', requireAuth(config.jwtSecret), async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) throw notFound('User not found');
    res.json({ user });
  });

  return router;
}
