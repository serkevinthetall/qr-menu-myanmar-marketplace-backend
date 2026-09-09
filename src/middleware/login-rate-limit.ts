import type { NextFunction, Request, Response } from 'express';

import { clientIpFromRequest } from '../services/login-device.service.js';
import {
  clearFailedLogins,
  getLoginFailureStatus,
  lockoutMessage,
  recordFailedLogin,
} from '../services/login-rate-limit.service.js';

export function loginClientIp(req: Request): string {
  return clientIpFromRequest(req) || req.ip || 'unknown';
}

/** Block the request if this IP already hit the failed-login lockout. */
export async function assertLoginNotLocked(
  req: Request,
  res: Response,
): Promise<boolean> {
  const ip = loginClientIp(req);
  try {
    const status = await getLoginFailureStatus(ip);
    if (!status.blocked) return true;
    res.setHeader('Retry-After', String(status.retryAfterSec));
    res.status(429).json({
      message: lockoutMessage(status.retryAfterSec),
      retryAfterSeconds: status.retryAfterSec,
    });
    return false;
  } catch {
    // Fail open — never block legitimate users if the limiter breaks.
    return true;
  }
}

export async function onLoginSuccess(req: Request): Promise<void> {
  await clearFailedLogins(loginClientIp(req));
}

export async function onLoginFailure(
  req: Request,
  res: Response,
  authMessage: string,
  statusCode = 401,
): Promise<void> {
  const ip = loginClientIp(req);
  try {
    const status = await recordFailedLogin(ip);
    if (status.blocked) {
      res.setHeader('Retry-After', String(status.retryAfterSec));
      res.status(429).json({
        message: lockoutMessage(status.retryAfterSec),
        retryAfterSeconds: status.retryAfterSec,
      });
      return;
    }
  } catch {
    // ignore limiter errors
  }
  res.status(statusCode).json({ message: authMessage });
}

/** Optional Express middleware form (check lockout before handler). */
export async function loginRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const ok = await assertLoginNotLocked(req, res);
  if (ok) next();
}
