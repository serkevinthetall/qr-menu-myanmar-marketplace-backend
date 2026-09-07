import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient, type RedisClientType } from 'redis';

/**
 * Login attempt limiter (per IP).
 * Prefers shared Redis on Vercel (Upstash REST or REDIS_URL), else in-memory
 * (local/dev only — not shared across serverless instances).
 */

const KEY_PREFIX = 'qr-shop:login-rate:';

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
  if (bucket.count > MAX_ATTEMPTS) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return {
      allowed: false,
      remaining: 0,
      limit: MAX_ATTEMPTS,
      resetAt: bucket.resetAt,
      retryAfterSec,
    };
  }
  return {
    allowed: true,
    remaining: Math.max(0, MAX_ATTEMPTS - bucket.count),
    limit: MAX_ATTEMPTS,
    resetAt: bucket.resetAt,
  };
}

async function consumeUpstash(
  client: UpstashRedis,
  ip: string,
): Promise<LoginRateLimitResult> {
  const key = `${KEY_PREFIX}${ip || 'unknown'}`;
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, WINDOW_SEC);
  }
  const ttl = await client.ttl(key);
  const retryAfterSec = ttl > 0 ? ttl : WINDOW_SEC;
  const resetAt = Date.now() + retryAfterSec * 1000;
  if (count > MAX_ATTEMPTS) {
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

async function consumeTcp(
  client: RedisClientType,
  ip: string,
): Promise<LoginRateLimitResult> {
  const key = `${KEY_PREFIX}${ip || 'unknown'}`;
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, WINDOW_SEC);
  }
  const ttl = await client.ttl(key);
  const retryAfterSec = ttl > 0 ? ttl : WINDOW_SEC;
  const resetAt = Date.now() + retryAfterSec * 1000;
  if (count > MAX_ATTEMPTS) {
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

/** Record one login attempt for this IP. Fail-open to memory if Redis errors. */
export async function consumeLoginAttempt(
  ip: string,
): Promise<LoginRateLimitResult> {
  try {
    const upstash = getUpstashClient();
    if (upstash) {
      return await consumeUpstash(upstash, ip);
    }
    const tcp = await getTcpClient();
    if (tcp) {
      return await consumeTcp(tcp, ip);
    }
  } catch (error) {
    console.error(
      '[login-rate-limit] Redis limiter failed; using memory:',
      error instanceof Error ? error.message : error,
    );
  }
  return consumeMemory(ip);
}

export function loginRateLimitConfig() {
  return { max: MAX_ATTEMPTS, windowSec: WINDOW_SEC };
}
