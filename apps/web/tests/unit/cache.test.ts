import { afterEach, describe, expect, it, vi } from "vitest";
import IORedis from "ioredis";
import type { CacheClient } from "@/lib/cache";
import { getOrRevalidate, IoredisCacheClient } from "@/lib/cache";

class FakeCacheClient implements CacheClient {
  store = new Map<string, unknown>();

  get<T>(key: string): Promise<T | null> {
    return Promise.resolve((this.store.get(key) as T | undefined) ?? null);
  }
  set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  del(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

class ThrowingCacheClient implements CacheClient {
  get<T>(): Promise<T | null> {
    return Promise.reject(new Error("connection refused"));
  }
  set(): Promise<void> {
    return Promise.reject(new Error("connection refused"));
  }
  del(): Promise<void> {
    return Promise.reject(new Error("connection refused"));
  }
}

describe("getOrRevalidate", () => {
  it("computes and caches on a cold miss", async () => {
    const client = new FakeCacheClient();
    const compute = vi.fn().mockResolvedValue("fresh-value");

    const result = await getOrRevalidate({
      key: "k",
      freshTtlSeconds: 30,
      staleTtlSeconds: 300,
      compute,
      client,
    });

    expect(result).toEqual({ value: "fresh-value", stale: false });
    expect(compute).toHaveBeenCalledOnce();
    expect(client.store.has("k")).toBe(true);
  });

  it("serves from cache within the fresh window without recomputing", async () => {
    const client = new FakeCacheClient();
    const compute = vi.fn().mockResolvedValue("fresh-value");
    await getOrRevalidate({ key: "k", freshTtlSeconds: 30, staleTtlSeconds: 300, compute, client });

    compute.mockResolvedValue("should-not-be-used");
    const second = await getOrRevalidate({
      key: "k",
      freshTtlSeconds: 30,
      staleTtlSeconds: 300,
      compute,
      client,
    });

    expect(second).toEqual({ value: "fresh-value", stale: false });
    expect(compute).toHaveBeenCalledOnce();
  });

  it("serves stale value and triggers a background revalidation past the fresh window", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeCacheClient();
      const compute = vi.fn().mockResolvedValue("v1");
      await getOrRevalidate({
        key: "k",
        freshTtlSeconds: 10,
        staleTtlSeconds: 300,
        compute,
        client,
      });

      vi.advanceTimersByTime(20_000); // past fresh (10s), within stale (300s)
      compute.mockResolvedValue("v2");

      const stale = await getOrRevalidate({
        key: "k",
        freshTtlSeconds: 10,
        staleTtlSeconds: 300,
        compute,
        client,
      });
      expect(stale).toEqual({ value: "v1", stale: true });

      // Background refresh is fire-and-forget; flush microtasks.
      await vi.runAllTimersAsync();
      const cached = client.store.get("k") as { value: string } | undefined;
      expect(cached?.value).toBe("v2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recomputes once both the fresh and stale windows have elapsed", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeCacheClient();
      const compute = vi.fn().mockResolvedValue("v1");
      await getOrRevalidate({
        key: "k",
        freshTtlSeconds: 10,
        staleTtlSeconds: 20,
        compute,
        client,
      });

      vi.advanceTimersByTime(60_000); // past both windows
      compute.mockResolvedValue("v3");

      const result = await getOrRevalidate({
        key: "k",
        freshTtlSeconds: 10,
        staleTtlSeconds: 20,
        compute,
        client,
      });
      expect(result).toEqual({ value: "v3", stale: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades to computing fresh when the cache backend throws on read", async () => {
    const client = new ThrowingCacheClient();
    const compute = vi.fn().mockResolvedValue("computed-anyway");

    const result = await getOrRevalidate({
      key: "k",
      freshTtlSeconds: 30,
      staleTtlSeconds: 300,
      compute,
      client,
    });

    expect(result).toEqual({ value: "computed-anyway", stale: false });
  });
});

describe("IoredisCacheClient (real local Redis + graceful degradation)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("get/set/del round-trip against the real local Redis instance", async () => {
    const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
    });
    const client = new IoredisCacheClient(redis);
    try {
      const key = `test:cache:${crypto.randomUUID()}`;
      expect(await client.get(key)).toBeNull();

      await client.set(key, { hello: "world" }, 5);
      expect(await client.get(key)).toEqual({ hello: "world" });

      await client.del(key);
      expect(await client.get(key)).toBeNull();
    } finally {
      redis.disconnect();
    }
  });

  it("get/set/del never throw when Redis is unreachable — the real fallback path", async () => {
    // Deliberately unreachable port — proves IoredisCacheClient's own
    // try/catch degrades to null/no-op rather than propagating a
    // connection error to the caller (getOrRevalidate depends on this).
    const redis = new IORedis("redis://localhost:1", {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null,
      connectTimeout: 200,
    });
    // ioredis emits its own "error" event for the connection failure in
    // addition to rejecting the pending command's promise — IoredisCacheClient
    // already handles the rejection, so this just silences the otherwise
    // unhandled-event stderr noise, not a real behavior change.
    redis.on("error", () => undefined);
    const client = new IoredisCacheClient(redis);
    try {
      await expect(client.get("anything")).resolves.toBeNull();
      await expect(client.set("anything", "value", 5)).resolves.toBeUndefined();
      await expect(client.del("anything")).resolves.toBeUndefined();
    } finally {
      redis.disconnect();
    }
  });
});
