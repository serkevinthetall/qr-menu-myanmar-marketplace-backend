import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient, type RedisClientType } from 'redis';

import {
  connectMongo,
  isMongoConfigured,
} from '../config/mongo.js';
import { AuthSessionModel } from '../models/auth-session.model.js';
import type { OdooSession } from './odoo-session.store.js';

const KEY_PREFIX = 'qr-shop:auth-session:';

export type StoredAuthSession = {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  odooCookie: string;
  odooUid: number;
  surface: 'web' | 'app';
  expiresAt: number;
  createdAt: number;
};

type MemoryRow = StoredAuthSession;

const memorySessions = new Map<string, MemoryRow>();

let upstashClient: UpstashRedis | null | undefined;
let tcpClient: RedisClientType | null | undefined;
let tcpConnectPromise: Promise<RedisClientType | null> | null = null;
let warnedMemory = false;

function getUpstashClient(): UpstashRedis | null {
  if (upstashClient !== undefined) return upstashClient;
  const url = (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ''
  ).trim();
  const token = (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ''
  ).trim();
  if (!url || !token) {
    upstashClient = null;
    return null;
  }
  upstashClient = new UpstashRedis({ url, token });
  return upstashClient;
}

async function getTcpClient(): Promise<RedisClientType | null> {
  if (tcpClient !== undefined) return tcpClient;
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) {
    tcpClient = null;
    return null;
  }
  if (!tcpConnectPromise) {
    tcpConnectPromise = (async () => {
      const client = createClient({
        url,
        socket: {
          connectTimeout: 8_000,
          reconnectStrategy: retries => Math.min(retries * 200, 2_000),
        },
      });
      client.on('error', err => {
        console.error('[auth-session] Redis TCP error:', err.message);
      });
      await client.connect();
      tcpClient = client as RedisClientType;
      return tcpClient;
    })().catch(error => {
      tcpConnectPromise = null;
      tcpClient = null;
      console.error(
        '[auth-session] Redis TCP connect failed:',
        error instanceof Error ? error.message : error,
      );
      return null;
    });
  }
  return tcpConnectPromise;
}

function warnMemoryOnce() {
  if (
    warnedMemory ||
    (process.env.NODE_ENV ?? 'development') !== 'production'
  ) {
    return;
  }
  warnedMemory = true;
  console.warn(
    '[auth-session] No Redis/Mongo for server sessions; using memory. ' +
      'Set REDIS_URL or UPSTASH_* (preferred) or MONGODB_URI so Odoo cookies ' +
      'are not lost across Vercel instances.',
  );
}

function ttlSeconds(expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}

function toOdooSession(row: StoredAuthSession): OdooSession {
  return {
    cookie: row.odooCookie,
    uid: row.odooUid,
    login: row.email,
    createdAt: row.createdAt,
  };
}

async function saveRedis(
  row: StoredAuthSession,
): Promise<boolean> {
  const key = `${KEY_PREFIX}${row.sessionId}`;
  const ttl = ttlSeconds(row.expiresAt);
  const payload = JSON.stringify(row);

  const upstash = getUpstashClient();
  if (upstash) {
    await upstash.set(key, payload, { ex: ttl });
    return true;
  }
  const tcp = await getTcpClient();
  if (tcp) {
    await tcp.set(key, payload, { EX: ttl });
    return true;
  }
  return false;
}

async function loadRedis(sessionId: string): Promise<StoredAuthSession | null> {
  const key = `${KEY_PREFIX}${sessionId}`;
  let raw: string | null = null;

  const upstash = getUpstashClient();
  if (upstash) {
    const value = await upstash.get<string>(key);
    raw = typeof value === 'string' ? value : value ? JSON.stringify(value) : null;
  } else {
    const tcp = await getTcpClient();
    if (tcp) {
      raw = await tcp.get(key);
    }
  }

  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed?.sessionId || !parsed?.odooCookie) return null;
    if (Number(parsed.expiresAt) <= Date.now()) {
      await deleteRedis(sessionId);
      return null;
    }
    return parsed as StoredAuthSession;
  } catch {
    return null;
  }
}

async function deleteRedis(sessionId: string): Promise<void> {
  const key = `${KEY_PREFIX}${sessionId}`;
  const upstash = getUpstashClient();
  if (upstash) {
    await upstash.del(key);
    return;
  }
  const tcp = await getTcpClient();
  if (tcp) {
    await tcp.del(key);
  }
}

async function saveMongo(row: StoredAuthSession): Promise<boolean> {
  if (!isMongoConfigured()) return false;
  try {
    await connectMongo();
    await AuthSessionModel.findOneAndUpdate(
      { sessionId: row.sessionId },
      {
        $set: {
          userId: row.userId,
          email: row.email,
          name: row.name,
          odooCookie: row.odooCookie,
          odooUid: row.odooUid,
          surface: row.surface,
          expiresAt: new Date(row.expiresAt),
          createdAt: new Date(row.createdAt),
        },
      },
      { upsert: true, new: true },
    );
    return true;
  } catch (error) {
    console.error(
      '[auth-session] Mongo save failed:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function loadMongo(sessionId: string): Promise<StoredAuthSession | null> {
  if (!isMongoConfigured()) return null;
  try {
    await connectMongo();
    const row = await AuthSessionModel.findOne({ sessionId }).lean();
    if (!row) return null;
    const expiresAt = new Date(row.expiresAt).getTime();
    if (expiresAt <= Date.now()) {
      await AuthSessionModel.deleteOne({ sessionId });
      return null;
    }
    return {
      sessionId: row.sessionId,
      userId: row.userId,
      email: row.email,
      name: row.name,
      odooCookie: row.odooCookie,
      odooUid: row.odooUid,
      surface: row.surface === 'app' ? 'app' : 'web',
      expiresAt,
      createdAt: new Date(row.createdAt).getTime(),
    };
  } catch {
    return null;
  }
}

async function deleteMongo(sessionId: string): Promise<void> {
  if (!isMongoConfigured()) return;
  try {
    await connectMongo();
    await AuthSessionModel.deleteOne({ sessionId });
  } catch {
    // ignore
  }
}

/** Persist Odoo cookie server-side; JWT only carries sid. */
export async function saveAuthSession(input: {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  odooCookie: string;
  odooUid: number;
  surface: 'web' | 'app';
  expiresAtMs: number;
}): Promise<StoredAuthSession> {
  const row: StoredAuthSession = {
    sessionId: input.sessionId,
    userId: input.userId,
    email: input.email,
    name: input.name,
    odooCookie: input.odooCookie,
    odooUid: input.odooUid,
    surface: input.surface,
    expiresAt: input.expiresAtMs,
    createdAt: Date.now(),
  };

  try {
    if (await saveRedis(row)) {
      // Also mirror to Mongo when available for admin/debug resilience.
      void saveMongo(row);
      return row;
    }
  } catch (error) {
    console.error(
      '[auth-session] Redis save failed:',
      error instanceof Error ? error.message : error,
    );
  }

  if (await saveMongo(row)) {
    return row;
  }

  // Memory is not shared across Vercel instances — login would appear to
  // succeed then bounce back to /login on the next API call.
  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    throw new Error(
      'Session store unavailable. Configure REDIS_URL / UPSTASH_* or MONGODB_URI.',
    );
  }

  warnMemoryOnce();
  memorySessions.set(row.sessionId, row);
  return row;
}

export async function getAuthSession(
  sessionId: string | undefined,
): Promise<StoredAuthSession | null> {
  if (!sessionId) return null;

  try {
    const fromRedis = await loadRedis(sessionId);
    if (fromRedis) return fromRedis;
  } catch (error) {
    console.error(
      '[auth-session] Redis load failed:',
      error instanceof Error ? error.message : error,
    );
  }

  const fromMongo = await loadMongo(sessionId);
  if (fromMongo) return fromMongo;

  const mem = memorySessions.get(sessionId);
  if (!mem) return null;
  if (mem.expiresAt <= Date.now()) {
    memorySessions.delete(sessionId);
    return null;
  }
  return mem;
}

export async function deleteAuthSession(
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  try {
    await deleteRedis(sessionId);
  } catch {
    // ignore
  }
  await deleteMongo(sessionId);
  memorySessions.delete(sessionId);
}

export function authSessionToOdoo(
  row: StoredAuthSession,
): OdooSession {
  return toOdooSession(row);
}
