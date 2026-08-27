/**
 * @temp-feature app-install-call-list
 * TEMPORARY Mongo connection for Call List / app installs.
 * Safe to delete with the rest of the feature (see frontend/features/app-install/enabled.ts).
 */
import mongoose from 'mongoose';

import { seedDefaultAppPromotersIfEmpty } from '../models/app-promoter.model.js';
import { migrateLegacyNotCalledStatus } from '../models/app-install.model.js';
import { env } from './env.js';

declare global {
  // eslint-disable-next-line no-var
  var __qrShopMongoConn: typeof mongoose | undefined;
  // eslint-disable-next-line no-var
  var __qrShopMongoMigrated: boolean | undefined;
}

export function getMongoUri(): string {
  return (
    process.env.MONGODB_URI?.trim() ||
    process.env.MONGO_URL?.trim() ||
    process.env.MONGODB_URL?.trim() ||
    ''
  );
}

function formatMongoConnectError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/MONGODB_URI is not configured/i.test(raw)) {
    return raw;
  }
  return `MongoDB connection failed. ${raw || 'Unknown database error.'}`;
}

/**
 * Connect once and reuse across Vercel serverless invocations.
 */
export async function connectMongo(): Promise<typeof mongoose> {
  const existing = globalThis.__qrShopMongoConn;
  if (existing && existing.connection.readyState === 1) {
    if (!globalThis.__qrShopMongoMigrated) {
      await migrateLegacyNotCalledStatus();
      await seedDefaultAppPromotersIfEmpty();
      globalThis.__qrShopMongoMigrated = true;
    }
    return existing;
  }

  const uri = getMongoUri();
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not configured. Add it on the Vercel backend project.',
    );
  }

  try {
    mongoose.set('strictQuery', true);
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8_000,
      maxPoolSize: env.nodeEnv === 'production' ? 5 : 10,
    });
    globalThis.__qrShopMongoConn = conn;
    await migrateLegacyNotCalledStatus();
    await seedDefaultAppPromotersIfEmpty();
    globalThis.__qrShopMongoMigrated = true;
    return conn;
  } catch (error) {
    globalThis.__qrShopMongoConn = undefined;
    throw new Error(formatMongoConnectError(error));
  }
}

export function isMongoConfigured(): boolean {
  return Boolean(getMongoUri());
}

export function httpStatusForMongoError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (
    /MONGODB_URI is not configured/i.test(message) ||
    /MongoDB connection failed/i.test(message) ||
    /mongo/i.test(message)
  ) {
    return 503;
  }
  return 500;
}
