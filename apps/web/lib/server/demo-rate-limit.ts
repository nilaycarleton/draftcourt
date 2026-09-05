import { prisma, Prisma } from "@draftcourt/db";
import { getCacheClient } from "@/lib/cache";

/**
 * Anonymous rate limiting for guest demo drafts (Phase 3D).
 *
 * Uses Redis counters with bounded windows; falls back to PostgreSQL
 * counting if Redis is unavailable. All limits are per-capability or
 * per-hashed-IP as appropriate.
 */

export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
  keyPrefix: string;
}

export const DEMO_RATE_LIMITS: Record<string, RateLimitConfig> = {
  create: { windowSeconds: 3600, maxRequests: 3, keyPrefix: "demo:create" },
  resume: { windowSeconds: 60, maxRequests: 30, keyPrefix: "demo:resume" },
  userPick: { windowSeconds: 30, maxRequests: 10, keyPrefix: "demo:pick" },
  cpuPick: { windowSeconds: 30, maxRequests: 10, keyPrefix: "demo:cpu" },
  tokenFailure: { windowSeconds: 300, maxRequests: 5, keyPrefix: "demo:tokenfail" },
};

/** Check and increment a rate limit counter. Returns { allowed, retryAfterSeconds? }. */
export async function checkDemoRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const client = getCacheClient();
  const redisKey = `${config.keyPrefix}:${key}`;

  try {
    const current = await client.get<number>(redisKey);

    if (current !== null && current > 0) {
      // Check if we're still in the same window by storing timestamp
      // For simplicity, we use a fixed-window approach with Redis TTL
      if (current >= config.maxRequests) {
        return { allowed: false, retryAfterSeconds: config.windowSeconds };
      }
      await client.set(redisKey, current + 1, config.windowSeconds);
      return { allowed: true };
    } else {
      await client.set(redisKey, 1, config.windowSeconds);
      return { allowed: true };
    }
  } catch {
    // Redis unavailable — fall back to PostgreSQL counting
    return checkDemoRateLimitPostgres(key, config);
  }
}

/** PostgreSQL fallback for rate limiting when Redis is down. */
async function checkDemoRateLimitPostgres(
  key: string,
  config: RateLimitConfig,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  // Use audit_log as a makeshift rate limit table (action = rate limit key)
  // This is a lightweight fallback; production should have dedicated table
  const since = new Date(Date.now() - config.windowSeconds * 1000);

  // We use a special action prefix for demo rate limits
  const action = `demo.ratelimit:${config.keyPrefix}`;

  const count = await prisma.auditLog.count({
    where: {
      action,
      entityId: key,
      createdAt: { gte: since },
    },
  });

  if (count >= config.maxRequests) {
    return { allowed: false, retryAfterSeconds: config.windowSeconds };
  }

  // Record this attempt
  await prisma.auditLog.create({
    data: {
      actorId: null,
      action,
      entityType: "demo_ratelimit",
      entityId: key,
      beforeJson: Prisma.JsonNull,
      afterJson: { count: count + 1, windowSeconds: config.windowSeconds },
      traceId: crypto.randomUUID(),
    },
  });

  return { allowed: true };
}

/** Record a token failure for rate limiting. */
export async function recordDemoTokenFailure(
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  const { hashRateLimitKey } = await import("./demo-tokens");
  const key = hashRateLimitKey(ip, userAgent);
  const config = DEMO_RATE_LIMITS.tokenFailure ?? {
    windowSeconds: 300,
    maxRequests: 5,
    keyPrefix: "demo:tokenfail",
  };
  await checkDemoRateLimit(key, config);
}
