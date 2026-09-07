import { NextFunction, Request, Response } from 'express';

import { clientIpFromRequest } from '../services/login-device.service.js';
import { peekLoginRateLimit } from '../services/login-rate-limit.service.js';

function retryMinutesLabel(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * Block login when this IP already exceeded failed-attempt quota.
 * Does not increment — failed attempts are recorded in the login handler.
 */
export async function loginRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const ip = clientIpFromRequest(req) || req.ip || 'unknown';

  try {
    const result = await peekLoginRateLimit(ip);
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader(
      'X-RateLimit-Reset',
      String(Math.ceil(result.resetAt / 1000)),
    );

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({
        message: `Too many login attempts. Please try again in ${retryMinutesLabel(result.retryAfterSec)}.`,
        retryAfterSeconds: result.retryAfterSec,
      });
    }

    return next();
  } catch (error) {
    console.error(
      '[login-rate-limit] middleware error:',
      error instanceof Error ? error.message : error,
    );
    return next();
  }
}

export function loginClientIp(req: Request): string {
  return clientIpFromRequest(req) || req.ip || 'unknown';
}
