import { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import {
  authSessionToOdoo,
  getAuthSession,
} from '../services/auth-session.store.js';
import { isLoginDeviceRevoked, touchLoginDevice } from '../services/login-device.service.js';
import { setOdooSession } from '../services/odoo-session.store.js';
import { AuthRequest } from '../types/auth.js';
import { extractAccessToken } from '../utils/auth-cookie.js';

type JwtPayload = {
  sub: string;
  email: string;
  name: string;
  /** Login device / auth session id — required for server-side Odoo cookie lookup. */
  sid?: string;
  surface?: 'web' | 'app';
  iat?: number;
  exp?: number;
};

function isTokenInvalidatedByMassLogout(payload: JwtPayload): boolean {
  const raw = env.authInvalidateBefore;
  if (!raw) return false;
  const cutoffMs = Date.parse(raw);
  if (!Number.isFinite(cutoffMs)) return false;
  if (typeof payload.iat !== 'number') return true;
  return payload.iat * 1000 < cutoffMs;
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  const token = extractAccessToken(req);

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret) as JwtPayload;

    if (isTokenInvalidatedByMassLogout(payload)) {
      return res.status(401).json({
        message: 'Please log in again.',
      });
    }

    if (!payload.sid) {
      return res.status(401).json({
        message: 'Please log in again.',
      });
    }

    if (await isLoginDeviceRevoked(payload.sid)) {
      return res.status(401).json({
        message: 'This device was signed out. Please log in again.',
      });
    }

    const stored = await getAuthSession(payload.sid);
    if (!stored) {
      return res.status(401).json({
        message: 'Session expired. Please log in again.',
      });
    }

    const odooSession = authSessionToOdoo(stored);
    setOdooSession(payload.sub, odooSession);

    req.user = {
      id: payload.sub,
      name: payload.name || stored.name,
      email: payload.email || stored.email,
    };
    req.odooSession = odooSession;
    req.sessionId = payload.sid;
    req.tokenExpiresAt =
      typeof payload.exp === 'number'
        ? new Date(payload.exp * 1000).toISOString()
        : undefined;

    void touchLoginDevice(payload.sid);

    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}
