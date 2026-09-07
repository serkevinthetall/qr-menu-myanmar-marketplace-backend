import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient, type RedisClientType } from 'redis';

/**
 * Login failure limiter (per IP).
 * Only failed password/auth attempts count — successful logins do not.
 * Prefers shared Redis on Vercel; falls back to in-memory locally.
 */

// v2 clears locks created while every login POST (including the bounce loop) was counted.
const KEY_PREFIX = 'qr-shop:login-rate:v2:';

const MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.LOGIN_RATE_LIMIT_MAX ?? '10', 10) || 10,
);
const WINDOW_SEC = Math.max(
  60,
  Math.floor(
    (Number.parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? '', 10) ||
      15 * 60 * 1000) / 1000,
  ),
);

export type LoginRateLimitResult =
  | { allowed: true; remaining: number; limit: number; resetAt: number }
  | {
      allowed: false;
      remaining: 0;
      limit: number;
      resetAt: number;
      retryAfterSec: number;
    };

type MemoryBucket = { count: number; resetAt: number };

const memoryBuckets = new Map<string, MemoryBucket>();

let upstashClient: UpstashRedis | null | undefined;
let tcpClient: RedisClientType | null | undefined;
let tcpConnectPromise: Promise<RedisClientType | null> | null = null;
let warnedMemoryFallback = false;

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
        console.error('[login-rate-limit] Redis TCP error:', err.message);
      });
      await client.connect();
      tcpClient = client as RedisClientType;
      return tcpClient;
    })().catch(error => {
      tcpConnectPromise = null;
      tcpClient = null;
      console.error(
        '[login-rate-limit] Redis TCP connect failed:',
        error instanceof Error ? error.message : error,
      );
      return null;
    });
  }
  return tcpConnectPromise;
}

function warnMemoryFallbackOnce() {
  if (
    warnedMemoryFallback ||
    (process.env.NODE_ENV ?? 'development') !== 'production'
  ) {
    return;
  }
  warnedMemoryFallback = true;
  console.warn(
    '[login-rate-limit] Redis not configured; using in-memory limiter. ' +
      'Set REDIS_URL or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN ' +
      'so limits are shared across Vercel instances.',
  );
}

function resultFromCount(
  count: number,
  resetAt: number,
  now = Date.now(),
): LoginRateLimitResult {
  if (count >= MAX_ATTEMPTS) {
    const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
    return {
      allowed: false,
      remaining: 0,
      limit: MAX_ATTEMPTS,
      resetAt,
      retryAfterSec,
    };
  }
  return {
    allowed: true,
    remaining: Math.max(0, MAX_ATTEMPTS - count),
    limit: MAX_ATTEMPTS,
    resetAt,
  };
}

function peekMemory(ip: string): LoginRateLimitResult {
  warnMemoryFallbackOnce();
  const now = Date.now();
  const key = ip || 'unknown';
  const bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    return {
      allowed: true,
      remaining: MAX_ATTEMPTS,
      limit: MAX_ATTEMPTS,
      resetAt: now + WINDOW_SEC * 1000,
    };
  }
  return resultFromCount(bucket.count, bucket.resetAt, now);
}

function consumeMemory(ip: string): LoginRateLimitResult {
  warnMemoryFallbackOnce();
  const now = Date.now();
  const key = ip || 'unknown';
  let bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_SEC * 1000 };
    memoryBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return resultFromCount(bucket.count, bucket.resetAt, now);
}

async function peekRedis(
  getCount: () => Promise<number | null>,
  getTtl: () => Promise<number>,
): Promise<LoginRateLimitResult | null> {
  const countRaw = await getCount();
  if (countRaw == null) {
    return {
      allowed: true,
      remaining: MAX_ATTEMPTS,
      limit: MAX_ATTEMPTS,
      resetAt: Date.now() + WINDOW_SEC * 1000,
    };
  }
  const count = Number(countRaw) || 0;
  const ttl = await getTtl();
  const retryAfterSec = ttl > 0 ? ttl : WINDOW_SEC;
  return resultFromCount(count, Date.now() + retryAfterSec * 1000);
}

async function consumeRedisIncr(
  incr: () => Promise<number>,
  expireIfFirst: (count: number) => Promise<void>,
  getTtl: () => Promise<number>,
): Promise<LoginRateLimitResult> {
  const count = await incr();
  await expireIfFirst(count);
  const ttl = await getTtl();
  const retryAfterSec = ttl > 0 ? ttl : WINDOW_SEC;
  return resultFromCount(count, Date.now() + retryAfterSec * 1000);
}

/** Check whether this IP is currently locked (does not increment). */
export async function peekLoginRateLimit(
  ip: string,
): Promise<LoginRateLimitResult> {
  const key = `${KEY_PREFIX}${ip || 'unknown'}`;
  try {
    const upstash = getUpstashClient();
    if (upstash) {
      const peeked = await peekRedis(
        async () => {
          const value = await upstash.get<number | string>(key);
          if (value == null) return null;
          return Number(value);
        },
        async () => Number(await upstash.ttl(key)),
      );
      if (peeked) return peeked;
    }
    const tcp = await getTcpClient();
    if (tcp) {
      const peeked = await peekRedis(
        async () => {
          const value = await tcp.get(key);
          if (value == null) return null;
          return Number(value);
        },
        async () => Number(await tcp.ttl(key)),
      );
      if (peeked) return peeked;
    }
  } catch (error) {
    console.error(
      '[login-rate-limit] peek failed; allowing request:',
      error instanceof Error ? error.message : error,
    );
    return {
      allowed: true,
      remaining: MAX_ATTEMPTS,
      limit: MAX_ATTEMPTS,
      resetAt: Date.now() + WINDOW_SEC * 1000,
    };
  }
  return peekMemory(ip);
}

/** Record one failed login (wrong password). Successful logins must not call this. */
export async function recordFailedLoginAttempt(
  ip: string,
): Promise<LoginRateLimitResult> {
  const key = `${KEY_PREFIX}${ip || 'unknown'}`;
  try {
    const upstash = getUpstashClient();
    if (upstash) {
      return await consumeRedisIncr(
        () => upstash.incr(key),
        async count => {
          if (count === 1) await upstash.expire(key, WINDOW_SEC);
        },
        async () => Number(await upstash.ttl(key)),
      );
    }
    const tcp = await getTcpClient();
    if (tcp) {
      return await consumeRedisIncr(
        () => tcp.incr(key),
        async count => {
          if (count === 1) await tcp.expire(key, WINDOW_SEC);
        },
        async () => Number(await tcp.ttl(key)),
      );
    }
  } catch (error) {
    console.error(
      '[login-rate-limit] record failed; using memory:',
      error instanceof Error ? error.message : error,
    );
  }
  return consumeMemory(ip);
}

export function loginRateLimitConfig() {
  return { max: MAX_ATTEMPTS, windowSec: WINDOW_SEC };
}
