import { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import { isLoginDeviceRevoked, touchLoginDevice } from '../services/login-device.service.js';
import { resolveOdooSession, setOdooSession } from '../services/odoo-session.store.js';
import { AuthRequest } from '../types/auth.js';

type JwtPayload = {
  sub: string;
  email: string;
  name: string;
  odooCookie?: string;
  odooUid?: number;
  /** Login device session id (Settings → Devices). */
  sid?: string;
  iat?: number;
};

function isTokenInvalidatedByMassLogout(payload: JwtPayload): boolean {
  const raw = env.authInvalidateBefore;
  if (!raw) return false;
  const cutoffMs = Date.parse(raw);
  if (!Number.isFinite(cutoffMs)) return false;
  // Prefer JWT iat; if missing, force re-login while cutoff is set.
  if (typeof payload.iat !== 'number') return true;
  return payload.iat * 1000 < cutoffMs;
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, env.jwtSecret) as JwtPayload;

    if (isTokenInvalidatedByMassLogout(payload)) {
      return res.status(401).json({
        message: 'Please log in again.',
      });
    }

    if (await isLoginDeviceRevoked(payload.sid)) {
      return res.status(401).json({
        message: 'This device was signed out. Please log in again.',
      });
    }

    const odooSession = resolveOdooSession(payload);

    if (!odooSession) {
      return res
        .status(401)
        .json({ message: 'Session expired. Please log in again.' });
    }

    setOdooSession(payload.sub, odooSession);

    req.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
    };
    req.odooSession = odooSession;
    req.sessionId = payload.sid;

    void touchLoginDevice(payload.sid);

    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}
