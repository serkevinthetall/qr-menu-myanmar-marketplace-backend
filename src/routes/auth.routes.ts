import { Router } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  clientIpFromRequest,
  listLoginDevices,
  recordLoginDevice,
  revokeLoginDevice,
  revokeLoginDeviceById,
} from '../services/login-device.service.js';
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
        ...(sessionId ? { sid: sessionId } : {}),
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

router.get('/devices', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const devices = await listLoginDevices(req.user!.id, req.sessionId);
    return res.json({
      data: devices.map(device => ({
        id: device.id,
        label: device.label,
        platform: device.platform,
        browser: device.browser,
        ip: device.ip,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        current: device.current,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load devices.';
    return res.status(500).json({ message });
  }
});

router.delete('/devices/:id', authMiddleware, async (req: AuthRequest, res) => {
  const deviceId = String(req.params.id || '').trim();
  if (!deviceId) {
    return res.status(400).json({ message: 'Device id is required.' });
  }

  try {
    const result = await revokeLoginDeviceById(
      req.user!.id,
      deviceId,
      req.sessionId,
    );
    if (!result.ok) {
      return res.status(404).json({ message: 'Device session not found.' });
    }
    return res.json({
      data: {
        revoked: true,
        revokedCurrent: result.revokedCurrent,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to sign out device.';
    return res.status(500).json({ message });
  }
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
