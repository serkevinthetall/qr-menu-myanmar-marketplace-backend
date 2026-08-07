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
    // Production custom domains for QR Shop website.
    if (
      hostname === 'qrshopmyanmar.com' ||
      hostname.endsWith('.qrshopmyanmar.com')
    ) {
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

  /** Product membership pricelist names (matched with ilike). */
  odooPricelistPremiumName: (
    process.env.ODOO_PRICELIST_PREMIUM_NAME ?? 'Premium Membership'
  ).trim(),
  odooPricelistProName: (
    process.env.ODOO_PRICELIST_PRO_NAME ?? 'Pro Membership'
  ).trim(),

  /** MongoDB Atlas connection (temporary Call list / App installation). */
  mongodbUri: (
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.MONGODB_URL ||
    ''
  ).trim(),

  /**
   * TEMPORARY — App install Call List API.
   * Set ENABLE_APP_INSTALL_CALL_LIST=false to unmount routes immediately.
   * Defaults on when MONGODB_URI is set.
   * Removal: see frontend/features/app-install/enabled.ts checklist.
   */
  enableAppInstallCallList: (() => {
    const flag = (process.env.ENABLE_APP_INSTALL_CALL_LIST ?? '').trim().toLowerCase();
    if (flag === 'false' || flag === '0' || flag === 'off') {
      return false;
    }
    if (flag === 'true' || flag === '1' || flag === 'on') {
      return true;
    }
    return Boolean(
      (
        process.env.MONGODB_URI ||
        process.env.MONGO_URL ||
        process.env.MONGODB_URL ||
        ''
      ).trim(),
    );
  })(),

  /**
   * Optional Groq AI suggestions for Overview.
   * Set AI_INSIGHTS_ENABLED=false (or omit) to fully disable — easy to remove later.
   */
  aiInsightsEnabled: (process.env.AI_INSIGHTS_ENABLED ?? 'false').toLowerCase() === 'true',
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  groqModel: (process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant').trim(),
};
