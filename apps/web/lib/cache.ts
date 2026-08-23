import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";
import { env } from "@/lib/env";

/**
 * Minimal cache client contract every backend below implements identically
 * — callers (`getOrRevalidate`) never know which backend is active.
 * `get`/`set` never throw: a backend error is caught internally and
 * treated as a cache miss / no-op set, so a Redis outage degrades to
 * "always compute fresh" rather than a 500.
 */
export interface CacheClient {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class UpstashCacheClient implements CacheClient {
  constructor(private readonly client: UpstashRedis) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      return await this.client.get<T>(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, { ex: ttlSeconds });
    } catch {
      // Degrade silently — see interface doc.
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      // Degrade silently.
    }
  }
}

export class IoredisCacheClient implements CacheClient {
  constructor(private readonly client: IORedis) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
      // Degrade silently.
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      // Degrade silently.
    }
  }
}

/** No Redis configured at all — every read is a miss, every write a no-op.
 * Callers always compute fresh; this is the same code path as a Redis
 * outage, just permanent rather than transient. */
export class NoopCacheClient implements CacheClient {
  get<T>(): Promise<T | null> {
    return Promise.resolve(null);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  del(): Promise<void> {
    return Promise.resolve();
  }
}

let cachedClient: CacheClient | undefined;

/** Upstash REST (when configured) > local `ioredis` (when `REDIS_URL` set)
 * > no-op — same precedence documented in ADR 0008. Lazily constructed and
 * memoized once per process. */
export function getCacheClient(): CacheClient {
  if (cachedClient) return cachedClient;

  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    cachedClient = new UpstashCacheClient(
      new UpstashRedis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }),
    );
  } else if (env.REDIS_URL) {
    cachedClient = new IoredisCacheClient(
      new IORedis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: false,
        retryStrategy: () => null,
      }),
    );
  } else {
    cachedClient = new NoopCacheClient();
  }
  return cachedClient;
}

/** Test-only seam: replace the memoized client (e.g. with an in-memory
 * fake) or clear it to force re-selection on the next call. */
export function __setCacheClientForTesting(client: CacheClient | undefined): void {
  cachedClient = client;
}

interface CachedEnvelope<T> {
  value: T;
  cachedAt: number;
}

export interface RevalidateResult<T> {
  value: T;
  /** True when this value was served from the stale window while a fresh
   * value was fetched in the background — callers may want to surface a
   * "stale" indicator (BUILD_SPEC.md section 8: public rankings only). */
  stale: boolean;
}

/**
 * Stale-while-revalidate read-through cache. Within `freshTtlSeconds` of
 * being cached, a value is returned as-is. Beyond that but within
 * `freshTtlSeconds + staleTtlSeconds`, the stale value is returned
 * immediately and a background refresh is kicked off (never blocking the
 * caller). Beyond both windows — or on any cache error — `compute()` runs
 * inline and its result is cached for next time.
 */
export async function getOrRevalidate<T>(options: {
  key: string;
  freshTtlSeconds: number;
  staleTtlSeconds: number;
  compute: () => Promise<T>;
  client?: CacheClient;
}): Promise<RevalidateResult<T>> {
  const client = options.client ?? getCacheClient();
  // Defense in depth: the `CacheClient` contract documents get/set as
  // never-throwing, but a misbehaving backend must still never turn into a
  // 500 here — this is the one path every public read goes through.
  const cached = await client.get<CachedEnvelope<T>>(options.key).catch(() => null);
  const now = Date.now();

  if (cached) {
    const ageSeconds = (now - cached.cachedAt) / 1000;
    if (ageSeconds <= options.freshTtlSeconds) {
      return { value: cached.value, stale: false };
    }
    if (ageSeconds <= options.freshTtlSeconds + options.staleTtlSeconds) {
      void refreshInBackground(client, options);
      return { value: cached.value, stale: true };
    }
  }

  const value = await options.compute();
  await client
    .set(options.key, { value, cachedAt: now }, options.freshTtlSeconds + options.staleTtlSeconds)
    .catch(() => undefined);
  return { value, stale: false };
}

async function refreshInBackground<T>(
  client: CacheClient,
  options: {
    key: string;
    freshTtlSeconds: number;
    staleTtlSeconds: number;
    compute: () => Promise<T>;
  },
): Promise<void> {
  try {
    const value = await options.compute();
    await client.set(
      options.key,
      { value, cachedAt: Date.now() },
      options.freshTtlSeconds + options.staleTtlSeconds,
    );
  } catch {
    // A failed background refresh just means the stale value keeps serving
    // until the next request re-attempts it — never surfaced to the caller
    // that already got its (stale) response.
  }
}
