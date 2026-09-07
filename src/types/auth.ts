import type { OdooSession } from '../services/odoo-session.store.js';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
};

export type AuthRequest = import('express').Request & {
  user?: AuthUser;
  odooSession?: OdooSession;
  /** JWT `sid` — login device session id. */
  sessionId?: string;
};
