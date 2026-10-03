import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient, type RedisClientType } from 'redis';

/**
 * App Order notify bus (Odoo webhook → website).
 *
 * Redis keys (preferred on Vercel):
 *  - qr-shop:app-order-notify:rev      (string counter)
 *  - qr-shop:app-order-notify:events   (list of JSON, newest left)
 *  - qr-shop:app-order-notify:pending  (set of unread-ish order ids)
 *  - qr-shop:app-order-notify:active   (flag that webhook has fired)
 *
 * Local fallback: JSON file under data/app-order-notify/.
 */

const REV_KEY = 'qr-shop:app-order-notify:rev';
const EVENTS_KEY = 'qr-shop:app-order-notify:events';
const PENDING_KEY = 'qr-shop:app-order-notify:pending';
const ACTIVE_KEY = 'qr-shop:app-order-notify:active';
/** Pub/Sub channel — webhook publishes, SSE subscribers receive instantly. */
const CHANNEL = 'qr-shop:app-order-notify:ch';
const MAX_EVENTS = 100;
const REDIS_RETRY_MS = 60_000;

export type AppOrderNotifyEvent = {
  revision: number;
  id: number;
  number: string;
  customer: string;
  total: number;
  at: string;
};

type FileStore = {
  revision: number;
  active: boolean;
  pendingIds: number[];
  events: AppOrderNotifyEvent[];
};

type RedisBackend =
  | { kind: 'upstash'; client: UpstashRedis }
  | { kind: 'tcp'; client: RedisClientType };

let redisBackend: RedisBackend | null | undefined;
let redisBackendCheckedAt = 0;
let tcpConnectPromise: Promise<RedisClientType> | null = null;

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
        console.error('[app-order-notify] Redis TCP error:', err.message);
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
  if (redisBackend) return redisBackend;
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
      '[app-order-notify] REDIS_URL connect failed:',
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

function normalizeId(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function storeRoot(): string {
  return (
    process.env.APP_ORDER_NOTIFY_DATA_DIR?.trim() ||
    path.join(process.cwd(), 'data', 'app-order-notify')
  );
}

async function resolveWritableRoot(): Promise<string> {
  const primary = storeRoot();
  try {
    await mkdir(primary, { recursive: true });
    const probe = path.join(primary, '.write-probe');
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe).catch(() => undefined);
    return primary;
  } catch {
    const fallback = path.join('/tmp', 'qr-shop-app-order-notify');
    await mkdir(fallback, { recursive: true });
    return fallback;
  }
}

function filePath(root: string): string {
  return path.join(root, 'notify.json');
}

async function readFileStore(): Promise<FileStore> {
  try {
    const root = await resolveWritableRoot();
    const raw = await readFile(filePath(root), 'utf8');
    const parsed = JSON.parse(raw) as FileStore;
    return {
      revision: Number(parsed.revision) || 0,
      active: Boolean(parsed.active),
      pendingIds: (parsed.pendingIds || [])
        .map(normalizeId)
        .filter(Boolean),
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return { revision: 0, active: false, pendingIds: [], events: [] };
  }
}

async function writeFileStore(data: FileStore): Promise<void> {
  const root = await resolveWritableRoot();
  await writeFile(filePath(root), JSON.stringify(data, null, 2), 'utf8');
}

function parseEvent(raw: unknown): AppOrderNotifyEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = normalizeId(row.id);
  if (!id) return null;
  return {
    revision: Number(row.revision) || 0,
    id,
    number: String(row.number ?? ''),
    customer: String(row.customer ?? ''),
    total: Number(row.total) || 0,
    at: String(row.at ?? new Date().toISOString()),
  };
}

export async function recordAppOrderNotifyEvent(input: {
  id: number;
  number?: string;
  customer?: string;
  total?: number;
  /** When false, only seeds pending (no alert event / revision bump for sound). */
  alert?: boolean;
}): Promise<AppOrderNotifyEvent | null> {
  const id = normalizeId(input.id);
  if (!id) return null;

  const alert = input.alert !== false;
  const at = new Date().toISOString();

  try {
    const backend = await getRedisBackend();
    if (backend) {
      if (backend.kind === 'upstash') {
        await backend.client.sadd(PENDING_KEY, String(id));
        if (!alert) return null;
        await backend.client.set(ACTIVE_KEY, '1');
        const revision = Number(await backend.client.incr(REV_KEY));
        const event: AppOrderNotifyEvent = {
          revision,
          id,
          number: String(input.number ?? ''),
          customer: String(input.customer ?? ''),
          total: Number(input.total) || 0,
          at,
        };
        await backend.client.lpush(EVENTS_KEY, JSON.stringify(event));
        await backend.client.ltrim(EVENTS_KEY, 0, MAX_EVENTS - 1);
        await publishAppOrderNotify(event);
        return event;
      }

      await backend.client.sAdd(PENDING_KEY, String(id));
      if (!alert) return null;
      await backend.client.set(ACTIVE_KEY, '1');
      const revision = Number(await backend.client.incr(REV_KEY));
      const event: AppOrderNotifyEvent = {
        revision,
        id,
        number: String(input.number ?? ''),
        customer: String(input.customer ?? ''),
        total: Number(input.total) || 0,
        at,
      };
      await backend.client.lPush(EVENTS_KEY, JSON.stringify(event));
      await backend.client.lTrim(EVENTS_KEY, 0, MAX_EVENTS - 1);
      await publishAppOrderNotify(event);
      return event;
    }
  } catch (error) {
    console.error(
      '[app-order-notify] Redis write failed:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    redisBackendCheckedAt = Date.now();
  }

  const store = await readFileStore();
  if (!store.pendingIds.includes(id)) store.pendingIds.push(id);
  if (!alert) {
    await writeFileStore(store);
    return null;
  }
  store.active = true;
  store.revision += 1;
  const event: AppOrderNotifyEvent = {
    revision: store.revision,
    id,
    number: String(input.number ?? ''),
    customer: String(input.customer ?? ''),
    total: Number(input.total) || 0,
    at,
  };
  store.events = [event, ...store.events].slice(0, MAX_EVENTS);
  await writeFileStore(store);
  await publishAppOrderNotify(event);
  return event;
}

/** Push to all SSE listeners (Redis Pub/Sub). Call after unread is stored. */
export async function publishAppOrderNotify(
  event: AppOrderNotifyEvent,
): Promise<void> {
  const payload = JSON.stringify(event);
  try {
    const backend = await getRedisBackend();
    if (backend?.kind === 'upstash') {
      await backend.client.publish(CHANNEL, payload);
      return;
    }
    if (backend?.kind === 'tcp') {
      await backend.client.publish(CHANNEL, payload);
      return;
    }
  } catch (error) {
    console.error(
      '[app-order-notify] publish failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Subscribe to live App Order notifies (dedicated TCP connection).
 * Returns an unsubscribe fn. Falls back to null when only REST Redis is available.
 */
export async function subscribeAppOrderNotify(
  onEvent: (event: AppOrderNotifyEvent) => void,
): Promise<(() => Promise<void>) | null> {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) return null;

  try {
    const sub = createClient({
      url,
      socket: {
        connectTimeout: 8_000,
        reconnectStrategy: retries => Math.min(retries * 200, 2_000),
      },
    });
    sub.on('error', err => {
      console.error('[app-order-notify] subscribe error:', err.message);
    });
    await sub.connect();
    await sub.subscribe(CHANNEL, message => {
      try {
        const parsed = parseEvent(
          typeof message === 'string' ? JSON.parse(message) : message,
        );
        if (parsed) onEvent(parsed);
      } catch {
        // ignore bad payloads
      }
    });
    return async () => {
      try {
        await sub.unsubscribe(CHANNEL);
        await sub.quit();
      } catch {
        // ignore
      }
    };
  } catch (error) {
    console.error(
      '[app-order-notify] subscribe connect failed:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function seedPendingAppOrderIds(orderIds: number[]): Promise<void> {
  const ids = [...new Set(orderIds.map(normalizeId).filter(Boolean))];
  if (!ids.length) return;
  for (const id of ids) {
    await recordAppOrderNotifyEvent({ id, alert: false });
  }
}

export async function clearPendingAppOrderIds(orderIds: number[]): Promise<void> {
  const ids = [...new Set(orderIds.map(normalizeId).filter(Boolean))];
  if (!ids.length) return;

  try {
    const backend = await getRedisBackend();
    if (backend) {
      const members = ids.map(String);
      if (backend.kind === 'upstash') {
        for (const member of members) {
          await backend.client.srem(PENDING_KEY, member);
        }
      } else {
        await backend.client.sRem(PENDING_KEY, members);
      }
      return;
    }
  } catch (error) {
    console.error(
      '[app-order-notify] Redis clear pending failed:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    redisBackendCheckedAt = Date.now();
  }

  const store = await readFileStore();
  const remove = new Set(ids);
  store.pendingIds = store.pendingIds.filter(id => !remove.has(id));
  await writeFileStore(store);
}

/** Bump revision so website polls refresh unreadCount (e.g. after delete). */
export async function bumpAppOrderNotifyRevision(): Promise<number> {
  try {
    const backend = await getRedisBackend();
    if (backend) {
      if (backend.kind === 'upstash') {
        return Number(await backend.client.incr(REV_KEY)) || 0;
      }
      return Number(await backend.client.incr(REV_KEY)) || 0;
    }
  } catch (error) {
    console.error(
      '[app-order-notify] revision bump failed:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    redisBackendCheckedAt = Date.now();
  }

  const store = await readFileStore();
  store.revision += 1;
  await writeFileStore(store);
  return store.revision;
}

/**
 * Drop pending ids that no longer exist in Odoo (deleted sale orders).
 * `existingIds` = sale.order ids that still exist.
 */
export async function prunePendingAppOrderIdsNotExisting(
  existingIds: Set<number>,
): Promise<number[]> {
  const pending = await listPendingAppOrderIds();
  if (!pending.size) return [];
  const missing = [...pending].filter(id => !existingIds.has(id));
  if (!missing.length) return [];
  await clearPendingAppOrderIds(missing);
  await bumpAppOrderNotifyRevision();
  return missing;
}

export async function listPendingAppOrderIds(): Promise<Set<number>> {
  try {
    const backend = await getRedisBackend();
    if (backend) {
      if (backend.kind === 'upstash') {
        const members = await backend.client.smembers(PENDING_KEY);
        return new Set(
          (members as unknown[]).map(normalizeId).filter(Boolean),
        );
      }
      const members = await backend.client.sMembers(PENDING_KEY);
      return new Set(members.map(normalizeId).filter(Boolean));
    }
  } catch (error) {
    console.error(
      '[app-order-notify] Redis list pending failed:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    redisBackendCheckedAt = Date.now();
  }

  const store = await readFileStore();
  return new Set(store.pendingIds);
}

export async function isAppOrderNotifyActive(): Promise<boolean> {
  try {
    const backend = await getRedisBackend();
    if (backend) {
      if (backend.kind === 'upstash') {
        return Boolean(await backend.client.get(ACTIVE_KEY));
      }
      return Boolean(await backend.client.get(ACTIVE_KEY));
    }
  } catch {
    // fall through
  }
  const store = await readFileStore();
  return store.active;
}

export async function getAppOrderNotifyRevision(): Promise<number> {
  try {
    const backend = await getRedisBackend();
    if (backend) {
      if (backend.kind === 'upstash') {
        return Number(await backend.client.get(REV_KEY)) || 0;
      }
      return Number(await backend.client.get(REV_KEY)) || 0;
    }
  } catch {
    // fall through
  }
  const store = await readFileStore();
  return store.revision;
}

export async function listAppOrderNotifyEventsSince(
  sinceRevision: number,
): Promise<{ revision: number; events: AppOrderNotifyEvent[]; active: boolean }> {
  const since = Number.isFinite(sinceRevision) ? Math.max(0, sinceRevision) : 0;

  try {
    const backend = await getRedisBackend();
    if (backend) {
      let raw: unknown[] = [];
      let revision = 0;
      let active = false;
      if (backend.kind === 'upstash') {
        raw = ((await backend.client.lrange(EVENTS_KEY, 0, MAX_EVENTS - 1)) ||
          []) as unknown[];
        revision = Number(await backend.client.get(REV_KEY)) || 0;
        active = Boolean(await backend.client.get(ACTIVE_KEY));
      } else {
        raw = await backend.client.lRange(EVENTS_KEY, 0, MAX_EVENTS - 1);
        revision = Number(await backend.client.get(REV_KEY)) || 0;
        active = Boolean(await backend.client.get(ACTIVE_KEY));
      }
      const events = raw
        .map(item => {
          if (typeof item === 'string') {
            try {
              return parseEvent(JSON.parse(item));
            } catch {
              return null;
            }
          }
          return parseEvent(item);
        })
        .filter((e): e is AppOrderNotifyEvent => Boolean(e))
        .filter(e => e.revision > since)
        .sort((a, b) => a.revision - b.revision);
      return { revision, events, active };
    }
  } catch (error) {
    console.error(
      '[app-order-notify] Redis feed failed:',
      error instanceof Error ? error.message : error,
    );
    redisBackend = null;
    redisBackendCheckedAt = Date.now();
  }

  const store = await readFileStore();
  const events = store.events
    .filter(e => e.revision > since)
    .sort((a, b) => a.revision - b.revision);
  return {
    revision: store.revision,
    events,
    active: store.active,
  };
}

/** Unread ≈ pending ids not in the read set. */
export async function countPendingUnreadAppOrders(
  readIds: Set<number>,
): Promise<number> {
  const pending = await listPendingAppOrderIds();
  let count = 0;
  for (const id of pending) {
    if (!readIds.has(id)) count += 1;
  }
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Long-poll helper: wait until revision advances (webhook wrote Redis),
 * or until timeout. Avoids busy client loops and Odoo search_read.
 */
export async function waitForAppOrderNotifyEvents(
  sinceRevision: number,
  timeoutMs = 8_000,
): Promise<{
  revision: number;
  events: AppOrderNotifyEvent[];
  active: boolean;
}> {
  const since = Number.isFinite(sinceRevision) ? Math.max(0, sinceRevision) : 0;
  const wait = Math.min(Math.max(timeoutMs, 1_000), 25_000);
  const deadline = Date.now() + wait;

  while (Date.now() < deadline) {
    const feed = await listAppOrderNotifyEventsSince(since);
    if (feed.revision > since) {
      return feed;
    }
    await sleep(700);
  }

  return listAppOrderNotifyEventsSince(since);
}
