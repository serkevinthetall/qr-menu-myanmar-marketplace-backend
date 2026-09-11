import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient, type RedisClientType } from 'redis';

import { connectMongo, isMongoConfigured } from '../config/mongo.js';
import { AppOrderReadModel } from '../models/app-order-read.model.js';

/**
 * Team-wide App Order read ids.
 *
 * On Vercel the filesystem is ephemeral and not shared across serverless
 * instances. Prefer:
 * 1) Upstash / Vercel KV REST (KV_* or UPSTASH_REDIS_REST_*)
 * 2) Redis Cloud TCP via REDIS_URL (Vercel Marketplace Redis)
 * 3) MongoDB (MONGODB_URI) — durable fallback when Redis is down
 * 4) Local JSON file fallback (dev only)
 */

const REDIS_KEY = 'qr-shop:app-order-read-ids';
const REDIS_RETRY_MS = 60_000;

type ReadFile = {
  readOrderIds: number[];
};

type RedisBackend =
  | { kind: 'upstash'; client: UpstashRedis }
  | { kind: 'tcp'; client: RedisClientType };

let redisBackend: RedisBackend | null | undefined;
let redisBackendCheckedAt = 0;
let warnedMissingStore = false;
let tcpConnectPromise: Promise<RedisClientType> | null = null;

function warnMissingStoreInProduction() {
  if (
    !warnedMissingStore &&
    (process.env.NODE_ENV ?? 'development') === 'production'
  ) {
    warnedMissingStore = true;
    console.warn(
      '[app-order-read] No Redis/Mongo for read state. Set REDIS_URL ' +
        '(or Upstash KV) and/or MONGODB_URI. Without this, unread badges ' +
        'reset across Vercel instances and climb to 99+.',
    );
  }
}

function getUpstashClient(): UpstashRedis | null {
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
  if (!url || !token) return null;
  return new UpstashRedis({ url, token });
}

async function getTcpClient(): Promise<RedisClientType | null> {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) return null;

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
        console.error('[app-order-read] Redis TCP error:', err.message);
      });
      await client.connect();
      return client as RedisClientType;
    })().catch(error => {
      tcpConnectPromise = null;
      throw error;
    });
  }

  return tcpConnectPromise;
}

async function getRedisBackend(): Promise<RedisBackend | null> {
  if (redisBackend) {
    return redisBackend;
  }
  if (
    redisBackend === null &&
    Date.now() - redisBackendCheckedAt < REDIS_RETRY_MS
  ) {
    return null;
  }

  const upstash = getUpstashClient();
  if (upstash) {
    redisBackend = { kind: 'upstash', client: upstash };
    redisBackendCheckedAt = Date.now();
    return redisBackend;
  }

  try {
    const tcp = await getTcpClient();
    if (tcp) {
      redisBackend = { kind: 'tcp', client: tcp };
      redisBackendCheckedAt = Date.now();
      return redisBackend;
    }
  } catch (error) {
    console.error(
      '[app-order-read] Failed to connect REDIS_URL:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    redisBackendCheckedAt = Date.now();
    return null;
  }

  redisBackend = null;
  redisBackendCheckedAt = Date.now();
  return null;
}

function normalizeIds(raw: unknown[]): number[] {
  return raw
    .map(value => Number(value))
    .filter(id => Number.isFinite(id) && id > 0);
}

async function listFromRedis(backend: RedisBackend): Promise<Set<number>> {
  if (backend.kind === 'upstash') {
    const members = await backend.client.smembers(REDIS_KEY);
    return new Set(normalizeIds(members as unknown[]));
  }
  const members = await backend.client.sMembers(REDIS_KEY);
  return new Set(normalizeIds(members));
}

async function setInRedis(
  backend: RedisBackend,
  orderId: number,
  read: boolean,
): Promise<void> {
  const member = String(orderId);
  if (backend.kind === 'upstash') {
    if (read) {
      await backend.client.sadd(REDIS_KEY, member);
    } else {
      await backend.client.srem(REDIS_KEY, member);
    }
    return;
  }
  if (read) {
    await backend.client.sAdd(REDIS_KEY, member);
  } else {
    await backend.client.sRem(REDIS_KEY, member);
  }
}

async function listFromMongo(): Promise<Set<number> | null> {
  if (!isMongoConfigured()) return null;
  try {
    await connectMongo();
    const rows = await AppOrderReadModel.find({}, { orderId: 1, _id: 0 })
      .lean()
      .exec();
    return new Set(
      normalizeIds(rows.map(row => (row as { orderId?: unknown }).orderId)),
    );
  } catch (error) {
    console.error(
      '[app-order-read] Mongo list failed:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function setInMongo(orderId: number, read: boolean): Promise<boolean> {
  if (!isMongoConfigured()) return false;
  try {
    await connectMongo();
    if (read) {
      await AppOrderReadModel.updateOne(
        { orderId },
        { $set: { orderId, readAt: new Date() } },
        { upsert: true },
      );
    } else {
      await AppOrderReadModel.deleteOne({ orderId });
    }
    return true;
  } catch (error) {
    console.error(
      '[app-order-read] Mongo write failed:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

function storeRoot(): string {
  const primary = path.join(process.cwd(), 'data', 'app-order-read');
  return process.env.APP_ORDER_READ_DATA_DIR?.trim() || primary;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function resolveWritableRoot(): Promise<string> {
  const primary = storeRoot();
  try {
    await ensureDir(primary);
    const probe = path.join(primary, '.write-probe');
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe).catch(() => undefined);
    return primary;
  } catch {
    const fallback = path.join('/tmp', 'qr-shop-app-order-read');
    await ensureDir(fallback);
    return fallback;
  }
}

function filePath(root: string): string {
  return path.join(root, 'read.json');
}

async function readAllFromFile(): Promise<ReadFile> {
  const root = await resolveWritableRoot();
  try {
    const raw = await readFile(filePath(root), 'utf8');
    const parsed = JSON.parse(raw) as ReadFile;
    if (!parsed || !Array.isArray(parsed.readOrderIds)) {
      return { readOrderIds: [] };
    }
    return { readOrderIds: normalizeIds(parsed.readOrderIds) };
  } catch {
    return { readOrderIds: [] };
  }
}

async function writeAllToFile(data: ReadFile): Promise<void> {
  const root = await resolveWritableRoot();
  await writeFile(filePath(root), JSON.stringify(data, null, 2), 'utf8');
}

/** Shared across all users/devices. */
export async function listReadAppOrderIds(): Promise<Set<number>> {
  const merged = new Set<number>();
  let redisListed = false;

  try {
    const backend = await getRedisBackend();
    if (backend) {
      const fromRedis = await listFromRedis(backend);
      for (const id of fromRedis) merged.add(id);
      redisListed = true;
    }
  } catch (error) {
    console.error(
      '[app-order-read] Redis list failed:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    redisBackendCheckedAt = Date.now();
  }

  const fromMongo = await listFromMongo();
  if (fromMongo) {
    for (const id of fromMongo) merged.add(id);
  }

  if (redisListed || fromMongo) {
    return merged;
  }

  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    warnMissingStoreInProduction();
    return new Set();
  }

  const all = await readAllFromFile();
  return new Set(all.readOrderIds);
}

export async function isAppOrderRead(orderId: number): Promise<boolean> {
  if (!Number.isFinite(orderId) || orderId <= 0) return false;
  const ids = await listReadAppOrderIds();
  return ids.has(orderId);
}

export async function setAppOrderRead(
  orderId: number,
  read: boolean,
): Promise<void> {
  if (!Number.isFinite(orderId) || orderId <= 0) return;

  let redisOk = false;
  try {
    const backend = await getRedisBackend();
    if (backend) {
      await setInRedis(backend, orderId, read);
      redisOk = true;
    }
  } catch (error) {
    console.error(
      '[app-order-read] Redis write failed:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    redisBackendCheckedAt = Date.now();
  }

  // Always mirror to Mongo when available so unread badges survive Redis blips.
  const mongoOk = await setInMongo(orderId, read);

  if (redisOk || mongoOk) {
    return;
  }

  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    warnMissingStoreInProduction();
    throw new Error(
      'App order read store unavailable. Configure REDIS_URL or MONGODB_URI.',
    );
  }

  const all = await readAllFromFile();
  const set = new Set(all.readOrderIds);
  if (read) {
    set.add(orderId);
  } else {
    set.delete(orderId);
  }
  await writeAllToFile({ readOrderIds: [...set].sort((a, b) => a - b) });
}
