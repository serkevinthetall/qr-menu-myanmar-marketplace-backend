import dotenv from 'dotenv';

import { getLanIPv4 } from '../utils/network.js';

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const detectedLanHost = getLanIPv4();
const configuredLanHost = process.env.LAN_HOST?.trim() || detectedLanHost || 'localhost';

function buildCorsOrigins(): string[] {
  const fromEnv = (process.env.CORS_ORIGINS ?? 'http://localhost:8081')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (nodeEnv !== 'development' || !detectedLanHost) {
    return [...new Set(fromEnv)];
  }

  const autoOrigins = [
    `http://${detectedLanHost}:8081`,
    `http://${detectedLanHost}:19006`,
  ];

  return [...new Set([...fromEnv, ...autoOrigins])];
}

const corsOrigins = buildCorsOrigins();

/**
 * Allow listed origins, plus Vercel preview/production frontend URLs.
 * Preview deployments get unique hostnames; blocking them causes browser
 * "Failed to fetch" on login even when the API is healthy.
 */
export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  if (corsOrigins.includes(origin)) {
    return true;
  }
  try {
    const { hostname } = new URL(origin);
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return true;
    }
    // Any Vercel frontend deployment (production + preview).
    if (hostname.endsWith('.vercel.app')) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  /** LAN IP for logs; auto-detected when possible. */
  lanHost: configuredLanHost,
  detectedLanHost,
  nodeEnv,
  jwtSecret:
    nodeEnv === 'production'
      ? required('JWT_SECRET')
      : required('JWT_SECRET', 'dev-only-change-in-production'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  corsOrigins,
  odooUrl: required('ODOO_URL').replace(/\/$/, ''),
  odooDb: required('ODOO_DB'),
  odooApiKey: process.env.ODOO_API_KEY ?? '',
  odooContactExtraFields: (process.env.ODOO_CONTACT_EXTRA_FIELDS ?? '')
    .split(',')
    .map(field => field.trim())
    .filter(Boolean),
  /** Technical name of the custom Odoo Township model (Studio). */
  odooTownshipModel: (process.env.ODOO_TOWNSHIP_MODEL ?? 'x_townships').trim(),
};
