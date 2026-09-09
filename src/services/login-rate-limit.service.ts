import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient, type RedisClientType } from 'redis';

/**
 * Failed-login limiter (per IP).
 * Successful logins clear the counter — normal use stays accessible.
 * Only repeated wrong passwords trip the lockout.
 */

const KEY_PREFIX = 'qr-shop:login-fail:';

/** Generous default: many typos OK; still stops credential stuffing. */
const MAX_FAILED = Math.max(
  5,
  Number.parseInt(process.env.LOGIN_RATE_LIMIT_MAX ?? '20', 10) || 20,
);
const WINDOW_SEC = Math.max(
  60,
  Math.floor(
    (Number.parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? '', 10) ||
      15 * 60 * 1000) / 1000,
  ),
);

export type LoginBlockStatus =
  | { blocked: false; failures: number; remaining: number; limit: number }
  | {
      blocked: true;
      failures: number;
      remaining: 0;
      limit: number;
      retryAfterSec: number;
    };

type MemoryBucket = { count: number; resetAt: number };

const memoryBuckets = new Map<string, MemoryBucket>();

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

function keyFor(ip: string): string {
  return `${KEY_PREFIX}${ip || 'unknown'}`;
}

function memoryStatus(ip: string): LoginBlockStatus {
  const now = Date.now();
  const bucket = memoryBuckets.get(ip || 'unknown');
  if (!bucket || bucket.resetAt <= now) {
    return {
      blocked: false,
      failures: 0,
      remaining: MAX_FAILED,
      limit: MAX_FAILED,
    };
  }
  if (bucket.count >= MAX_FAILED) {
    return {
      blocked: true,
      failures: bucket.count,
      remaining: 0,
      limit: MAX_FAILED,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return {
    blocked: false,
    failures: bucket.count,
    remaining: Math.max(0, MAX_FAILED - bucket.count),
    limit: MAX_FAILED,
  };
}

/** Check whether this IP is currently locked out (failed attempts only). */
export async function getLoginFailureStatus(
  ip: string,
): Promise<LoginBlockStatus> {
  try {
    const upstash = getUpstashClient();
    if (upstash) {
      const key = keyFor(ip);
      const raw = await upstash.get<number | string>(key);
      const count = Number(raw) || 0;
      const ttl = await upstash.ttl(key);
      if (count >= MAX_FAILED) {
        return {
          blocked: true,
          failures: count,
          remaining: 0,
          limit: MAX_FAILED,
          retryAfterSec: ttl > 0 ? ttl : WINDOW_SEC,
        };
      }
      return {
        blocked: false,
        failures: count,
        remaining: Math.max(0, MAX_FAILED - count),
        limit: MAX_FAILED,
      };
    }

    const tcp = await getTcpClient();
    if (tcp) {
      const key = keyFor(ip);
      const raw = await tcp.get(key);
      const count = Number(raw) || 0;
      const ttl = await tcp.ttl(key);
      if (count >= MAX_FAILED) {
        return {
          blocked: true,
          failures: count,
          remaining: 0,
          limit: MAX_FAILED,
          retryAfterSec: ttl > 0 ? ttl : WINDOW_SEC,
        };
      }
      return {
        blocked: false,
        failures: count,
        remaining: Math.max(0, MAX_FAILED - count),
        limit: MAX_FAILED,
      };
    }
  } catch (error) {
    console.error(
      '[login-rate-limit] status check failed (allowing login):',
      error instanceof Error ? error.message : error,
    );
    return {
      blocked: false,
      failures: 0,
      remaining: MAX_FAILED,
      limit: MAX_FAILED,
    };
  }

  return memoryStatus(ip);
}

/** Record one failed password attempt. Returns updated lockout status. */
export async function recordFailedLogin(
  ip: string,
): Promise<LoginBlockStatus> {
  try {
    const upstash = getUpstashClient();
    if (upstash) {
      const key = keyFor(ip);
      const count = await upstash.incr(key);
      if (count === 1) await upstash.expire(key, WINDOW_SEC);
      const ttl = await upstash.ttl(key);
      if (count >= MAX_FAILED) {
        return {
          blocked: true,
          failures: count,
          remaining: 0,
          limit: MAX_FAILED,
          retryAfterSec: ttl > 0 ? ttl : WINDOW_SEC,
        };
      }
      return {
        blocked: false,
        failures: count,
        remaining: Math.max(0, MAX_FAILED - count),
        limit: MAX_FAILED,
      };
    }

    const tcp = await getTcpClient();
    if (tcp) {
      const key = keyFor(ip);
      const count = await tcp.incr(key);
      if (count === 1) await tcp.expire(key, WINDOW_SEC);
      const ttl = await tcp.ttl(key);
      if (count >= MAX_FAILED) {
        return {
          blocked: true,
          failures: count,
          remaining: 0,
          limit: MAX_FAILED,
          retryAfterSec: ttl > 0 ? ttl : WINDOW_SEC,
        };
      }
      return {
        blocked: false,
        failures: count,
        remaining: Math.max(0, MAX_FAILED - count),
        limit: MAX_FAILED,
      };
    }
  } catch (error) {
    console.error(
      '[login-rate-limit] record failed (ignored):',
      error instanceof Error ? error.message : error,
    );
  }

  const now = Date.now();
  const k = ip || 'unknown';
  let bucket = memoryBuckets.get(k);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_SEC * 1000 };
    memoryBuckets.set(k, bucket);
  }
  bucket.count += 1;
  if (bucket.count >= MAX_FAILED) {
    return {
      blocked: true,
      failures: bucket.count,
      remaining: 0,
      limit: MAX_FAILED,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return {
    blocked: false,
    failures: bucket.count,
    remaining: Math.max(0, MAX_FAILED - bucket.count),
    limit: MAX_FAILED,
  };
}

/** Clear failed-login counter after a successful sign-in. */
export async function clearFailedLogins(ip: string): Promise<void> {
  try {
    const upstash = getUpstashClient();
    if (upstash) {
      await upstash.del(keyFor(ip));
      return;
    }
    const tcp = await getTcpClient();
    if (tcp) {
      await tcp.del(keyFor(ip));
      return;
    }
  } catch (error) {
    console.error(
      '[login-rate-limit] clear failed (ignored):',
      error instanceof Error ? error.message : error,
    );
  }
  memoryBuckets.delete(ip || 'unknown');
}

export function loginRateLimitConfig() {
  return { maxFailed: MAX_FAILED, windowSec: WINDOW_SEC };
}

export function lockoutMessage(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  const wait = minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return `Too many failed login attempts. Please wait ${wait} and try again.`;
}
