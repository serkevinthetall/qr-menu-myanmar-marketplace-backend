/**
 * Redis cache for the Contacts list (full partner catalog).
 * Uses the same Upstash / REDIS_URL stack as auth sessions.
 *
 * - Warm: one Odoo full fetch → Redis
 * - Hits: paged reads and shared across Vercel instances
 * - Deltas (since=): merge into Redis, return only changed rows
 * - Create/update: invalidate so the next load refreshes
 */
import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient, type RedisClientType } from 'redis';

const KEY_PREFIX = 'qr-shop:contacts:list:v1:';
/** Keep shared catalog warm for half an hour; writes invalidate earlier. */
const TTL_SECONDS = 30 * 60;

export type CachedContactListItem = {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  jobPosition: string;
  company: string;
  isCompany: boolean;
  activity: string;
  township: string;
  status: string;
  lastMonthSales: number;
  thisMonthSales: number;
  thisMonthPercent: number;
  lastInvoiceDate: string;
  expoPushToken: string;
  writeDate: string;
  active: boolean;
  extra: Record<string, string>;
};

export type ContactListCachePayload = {
  contacts: CachedContactListItem[];
  /** Max writeDate watermark for incremental clients. */
  since: string;
  updatedAt: number;
};

let upstashClient: UpstashRedis | null | undefined;
let tcpClient: RedisClientType | null | undefined;
let tcpConnectPromise: Promise<RedisClientType | null> | null = null;

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
        console.error('[contact-list-cache] Redis TCP error:', err.message);
      });
      await client.connect();
      tcpClient = client as RedisClientType;
      return tcpClient;
    })().catch(error => {
      tcpConnectPromise = null;
      tcpClient = null;
      console.error(
        '[contact-list-cache] Redis TCP connect failed:',
        error instanceof Error ? error.message : error,
      );
      return null;
    });
  }
  return tcpConnectPromise;
}

function cacheKey(suppliersOnly: boolean): string {
  return `${KEY_PREFIX}${suppliersOnly ? 'vendors' : 'all'}`;
}

export function maxContactWriteDate(
  contacts: Array<{ writeDate?: string }>,
): string {
  let max = '';
  for (const row of contacts) {
    const w = String(row.writeDate ?? '').trim();
    if (w && w > max) max = w;
  }
  return max;
}

function sortContactsByName(
  contacts: CachedContactListItem[],
): CachedContactListItem[] {
  return [...contacts].sort((a, b) => a.name.localeCompare(b.name));
}

export function mergeContactListItems(
  existing: CachedContactListItem[],
  delta: CachedContactListItem[],
): CachedContactListItem[] {
  if (delta.length === 0) return existing;
  const map = new Map(existing.map(item => [item.id, item]));
  for (const row of delta) {
    if (row.active === false) {
      map.delete(row.id);
    } else {
      map.set(row.id, row);
    }
  }
  return sortContactsByName(Array.from(map.values()));
}

export function sliceContactList(
  contacts: CachedContactListItem[],
  limit: number,
  offset: number,
): { data: CachedContactListItem[]; hasMore: boolean } {
  const start = Math.max(0, offset);
  const data = contacts.slice(start, start + limit);
  return {
    data,
    hasMore: start + data.length < contacts.length,
  };
}

export function filterContactsSince(
  contacts: CachedContactListItem[],
  since: string,
): CachedContactListItem[] {
  const watermark = since.trim();
  if (!watermark) return contacts;
  return contacts.filter(row => {
    const w = String(row.writeDate ?? '').trim();
    return Boolean(w && w >= watermark);
  });
}

export async function loadContactListCache(
  suppliersOnly: boolean,
): Promise<ContactListCachePayload | null> {
  const key = cacheKey(suppliersOnly);
  try {
    const upstash = getUpstashClient();
    if (upstash) {
      const raw = await upstash.get<string | ContactListCachePayload>(key);
      return parsePayload(raw);
    }
    const tcp = await getTcpClient();
    if (tcp) {
      const raw = await tcp.get(key);
      return parsePayload(raw);
    }
  } catch (error) {
    console.warn(
      '[contact-list-cache] load failed:',
      error instanceof Error ? error.message : error,
    );
  }
  return null;
}

function parsePayload(
  raw: string | ContactListCachePayload | null | undefined,
): ContactListCachePayload | null {
  if (!raw) return null;
  try {
    const parsed =
      typeof raw === 'string'
        ? (JSON.parse(raw) as ContactListCachePayload)
        : raw;
    if (!parsed || !Array.isArray(parsed.contacts)) return null;
    return {
      contacts: parsed.contacts,
      since:
        typeof parsed.since === 'string'
          ? parsed.since
          : maxContactWriteDate(parsed.contacts),
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export async function saveContactListCache(
  suppliersOnly: boolean,
  contacts: CachedContactListItem[],
): Promise<boolean> {
  const payload: ContactListCachePayload = {
    contacts: sortContactsByName(contacts),
    since: maxContactWriteDate(contacts),
    updatedAt: Date.now(),
  };
  const key = cacheKey(suppliersOnly);
  const body = JSON.stringify(payload);

  try {
    const upstash = getUpstashClient();
    if (upstash) {
      await upstash.set(key, body, { ex: TTL_SECONDS });
      return true;
    }
    const tcp = await getTcpClient();
    if (tcp) {
      await tcp.set(key, body, { EX: TTL_SECONDS });
      return true;
    }
  } catch (error) {
    console.warn(
      '[contact-list-cache] save failed:',
      error instanceof Error ? error.message : error,
    );
  }
  return false;
}

export async function mergeAndSaveContactListCache(
  suppliersOnly: boolean,
  delta: CachedContactListItem[],
): Promise<ContactListCachePayload | null> {
  if (delta.length === 0) {
    return loadContactListCache(suppliersOnly);
  }
  const current = await loadContactListCache(suppliersOnly);
  const merged = mergeContactListItems(current?.contacts ?? [], delta);
  await saveContactListCache(suppliersOnly, merged);
  return {
    contacts: merged,
    since: maxContactWriteDate(merged),
    updatedAt: Date.now(),
  };
}

export async function invalidateContactListCache(
  suppliersOnly?: boolean,
): Promise<void> {
  const keys =
    suppliersOnly === undefined
      ? [cacheKey(false), cacheKey(true)]
      : [cacheKey(suppliersOnly)];

  try {
    const upstash = getUpstashClient();
    if (upstash) {
      await Promise.all(keys.map(key => upstash.del(key)));
      return;
    }
    const tcp = await getTcpClient();
    if (tcp) {
      await Promise.all(keys.map(key => tcp.del(key)));
    }
  } catch (error) {
    console.warn(
      '[contact-list-cache] invalidate failed:',
      error instanceof Error ? error.message : error,
    );
  }
}
