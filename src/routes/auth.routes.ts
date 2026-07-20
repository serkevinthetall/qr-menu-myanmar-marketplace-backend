import { Router } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  authenticateWithOdoo,
  destroyOdooSession,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

// Odoo login can be an email OR a username — do not require email format.
const loginSchema = z.object({
  email: z.string().trim().min(1, 'Login is required.'),
  password: z.string().min(1, 'Password is required.'),
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse({
    email: typeof req.body?.email === 'string' ? req.body.email.trim() : req.body?.email,
    password:
      typeof req.body?.password === 'string' ? req.body.password : req.body?.password,
  });

  if (!parsed.success) {
    return res.status(400).json({
      message: 'Please enter your Odoo login and password.',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { email, password } = parsed.data;

  try {
    const odooUser = await authenticateWithOdoo(email, password);

    const signOptions: SignOptions = {
      expiresIn: env.jwtExpiresIn as SignOptions['expiresIn'],
    };

    const token = jwt.sign(
      {
        sub: String(odooUser.uid),
        email: odooUser.email,
        name: odooUser.name,
        odooCookie: odooUser.cookie,
        odooUid: odooUser.uid,
      },
      env.jwtSecret,
      signOptions,
    );

    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    return res.json({
      token,
      user: {
        id: String(odooUser.uid),
        name: odooUser.name,
        email: odooUser.email,
      },
      expiresAt,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Login failed. Please try again.';
    return res.status(401).json({ message });
  }
});

router.get('/me', authMiddleware, (req: AuthRequest, res) => {
  return res.json({ user: req.user });
});

router.post('/logout', authMiddleware, async (req: AuthRequest, res) => {
  if (req.user?.id) {
    await destroyOdooSession(req.user.id, req.odooSession);
  }

  return res.json({ message: 'Logged out successfully.' });
});

export default router;
