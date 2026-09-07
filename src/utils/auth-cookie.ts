import type { CookieOptions, Request, Response } from 'express';

import { env } from '../config/env.js';
import { parseJwtExpiresInMs } from '../utils/jwt-expiry.js';

/** httpOnly cookie used by the website ERP (not the native app). */
export const WEB_AUTH_COOKIE = 'qr_shop_auth';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function cookieOptions(maxAgeMs: number): CookieOptions {
  const isProd = env.nodeEnv === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    // Cross-site frontend (qrshopmyanmar.com) → API (*.vercel.app).
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: Math.max(0, Math.floor(maxAgeMs)),
  };
}

export function setWebAuthCookie(res: Response, token: string): void {
  const maxAge = parseJwtExpiresInMs(env.jwtExpiresIn);
  res.cookie(WEB_AUTH_COOKIE, token, cookieOptions(maxAge));
}

export function clearWebAuthCookie(res: Response): void {
  res.cookie(WEB_AUTH_COOKIE, '', {
    ...cookieOptions(0),
    maxAge: 0,
  });
}

/** Bearer token, else web httpOnly cookie. */
export function extractAccessToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const bearer = header.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookie = readCookie(req, WEB_AUTH_COOKIE);
  return cookie?.trim() || null;
}
