import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient, type RedisClientType } from 'redis';

/**
 * Team-wide App Order read ids.
 *
 * On Vercel the filesystem is ephemeral and not shared across serverless
 * instances. Prefer:
 * 1) Upstash / Vercel KV REST (KV_* or UPSTASH_REDIS_REST_*)
 * 2) Redis Cloud TCP via REDIS_URL (Vercel Marketplace Redis)
 * 3) Local JSON file fallback (dev only)
 */

const REDIS_KEY = 'qr-shop:app-order-read-ids';

type ReadFile = {
  readOrderIds: number[];
};

type RedisBackend =
  | { kind: 'upstash'; client: UpstashRedis }
  | { kind: 'tcp'; client: RedisClientType };

let redisBackend: RedisBackend | null | undefined;
let warnedMissingRedis = false;
let tcpConnectPromise: Promise<RedisClientType> | null = null;

function warnMissingRedisInProduction() {
  if (
    !warnedMissingRedis &&
    (process.env.NODE_ENV ?? 'development') === 'production'
  ) {
    warnedMissingRedis = true;
    console.warn(
      '[app-order-read] Redis not configured. Set REDIS_URL ' +
        '(Redis Cloud) or KV_REST_API_URL + KV_REST_API_TOKEN ' +
        '(Upstash). Without this, read/unread resets across Vercel instances.',
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
          // Serverless: fail fast rather than hang a request.
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
  if (redisBackend !== undefined) {
    return redisBackend;
  }

  const upstash = getUpstashClient();
  if (upstash) {
    redisBackend = { kind: 'upstash', client: upstash };
    return redisBackend;
  }

  try {
    const tcp = await getTcpClient();
    if (tcp) {
      redisBackend = { kind: 'tcp', client: tcp };
      return redisBackend;
    }
  } catch (error) {
    console.error(
      '[app-order-read] Failed to connect REDIS_URL:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    return null;
  }

  redisBackend = null;
  warnMissingRedisInProduction();
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
  const backend = await getRedisBackend();
  if (backend) {
    return listFromRedis(backend);
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

  const backend = await getRedisBackend();
  if (backend) {
    await setInRedis(backend, orderId, read);
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
