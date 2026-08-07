import mongoose from 'mongoose';

import { env } from './env.js';

declare global {
  // eslint-disable-next-line no-var
  var __qrShopMongoConn: typeof mongoose | undefined;
}

export function getMongoUri(): string {
  return (
    process.env.MONGODB_URI?.trim() ||
    process.env.MONGO_URL?.trim() ||
    process.env.MONGODB_URL?.trim() ||
    ''
  );
}

/**
 * Connect once and reuse across Vercel serverless invocations.
 */
export async function connectMongo(): Promise<typeof mongoose> {
  const existing = globalThis.__qrShopMongoConn;
  if (existing && existing.connection.readyState === 1) {
    return existing;
  }

  const uri = getMongoUri();
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not configured. Add it on the Vercel backend project.',
    );
  }

  mongoose.set('strictQuery', true);
  const conn = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8_000,
    maxPoolSize: env.nodeEnv === 'production' ? 5 : 10,
  });
  globalThis.__qrShopMongoConn = conn;
  return conn;
}

export function isMongoConfigured(): boolean {
  return Boolean(getMongoUri());
}
