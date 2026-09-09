import type { OdooSession } from '../services/odoo-session.store.js';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
};

export type AuthRequest = import('express').Request & {
  user?: AuthUser;
  odooSession?: OdooSession;
  /** JWT `sid` — login device / server auth session id. */
  sessionId?: string;
  /** ISO expiry from JWT `exp` when present. */
  tokenExpiresAt?: string;
  /** Which client issued this session (website vs sales app). */
  authSurface?: 'web' | 'app';
};
