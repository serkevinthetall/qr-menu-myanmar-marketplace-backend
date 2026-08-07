import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Redis } from '@upstash/redis';

/**
 * Team-wide App Order read ids.
 *
 * On Vercel the filesystem is ephemeral and not shared across serverless
 * instances, so production uses Upstash Redis (Vercel Marketplace KV/Redis).
 * Local/dev can fall back to a JSON file when Redis env vars are unset.
 */

const REDIS_KEY = 'qr-shop:app-order-read-ids';

type ReadFile = {
  readOrderIds: number[];
};

let redisClient: Redis | null | undefined;
let warnedMissingRedis = false;

function getRedis(): Redis | null {
  if (redisClient !== undefined) {
    return redisClient;
  }

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
    redisClient = null;
    if (
      !warnedMissingRedis &&
      (process.env.NODE_ENV ?? 'development') === 'production'
    ) {
      warnedMissingRedis = true;
      console.warn(
        '[app-order-read] Upstash Redis not configured. ' +
          'Set KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*) ' +
          'or read/unread will reset across Vercel instances.',
      );
    }
    return null;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

function normalizeIds(raw: unknown[]): number[] {
  return raw
    .map(value => Number(value))
    .filter(id => Number.isFinite(id) && id > 0);
}

async function listFromRedis(redis: Redis): Promise<Set<number>> {
  const members = await redis.smembers(REDIS_KEY);
  return new Set(normalizeIds(members as unknown[]));
}

async function setInRedis(
  redis: Redis,
  orderId: number,
  read: boolean,
): Promise<void> {
  const member = String(orderId);
  if (read) {
    await redis.sadd(REDIS_KEY, member);
  } else {
    await redis.srem(REDIS_KEY, member);
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
  const redis = getRedis();
  if (redis) {
    return listFromRedis(redis);
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

  const redis = getRedis();
  if (redis) {
    await setInRedis(redis, orderId, read);
    return;
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
