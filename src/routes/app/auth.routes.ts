import { Router } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { authMiddleware } from '../../middleware/auth.js';
import { loginRateLimitMiddleware } from '../../middleware/login-rate-limit.js';
import {
  clientIpFromRequest,
  recordLoginDevice,
  revokeLoginDevice,
} from '../../services/login-device.service.js';
import {
  authenticateWithOdoo,
  destroyOdooSession,
} from '../../services/odoo.service.js';
import { AuthRequest } from '../../types/auth.js';
import { jwtExpiresAtIso } from '../../utils/jwt-expiry.js';

const router = Router();

// Odoo login can be an email OR a username — do not require email format.
const loginSchema = z.object({
  email: z.string().trim().min(1, 'Login is required.'),
  password: z.string().min(1, 'Password is required.'),
});

/** Sales-rep app login — same Odoo auth, tagged for the handheld surface. */
router.post('/login', loginRateLimitMiddleware, async (req, res) => {
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

    const userAgent =
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent']
        : '';
    const sessionId = await recordLoginDevice({
      userId: String(odooUser.uid),
      userEmail: odooUser.email,
      userName: odooUser.name,
      meta: {
        userAgent,
        ip: clientIpFromRequest(req),
        surface: 'app',
      },
    });

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
        surface: 'app',
        ...(sessionId ? { sid: sessionId } : {}),
      },
      env.jwtSecret,
      signOptions,
    );

    const expiresAt = jwtExpiresAtIso(env.jwtExpiresIn);

    return res.json({
      token,
      user: {
        id: String(odooUser.uid),
        name: odooUser.name,
        email: odooUser.email,
      },
      expiresAt,
      surface: 'app',
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Login failed. Please try again.';
    return res.status(401).json({ message });
  }
});

router.get('/me', authMiddleware, (req: AuthRequest, res) => {
  return res.json({ user: req.user, surface: 'app' });
});

router.post('/logout', authMiddleware, async (req: AuthRequest, res) => {
  if (req.user?.id) {
    if (req.sessionId) {
      await revokeLoginDevice(req.user.id, req.sessionId);
    }
    await destroyOdooSession(req.user.id, req.odooSession);
  }

  return res.json({ message: 'Logged out successfully.' });
});

export default router;
