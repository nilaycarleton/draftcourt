import { createHash } from "node:crypto";
import { prisma, Prisma } from "@draftcourt/db";
import { getCacheClient, NoopCacheClient } from "@/lib/cache";

/**
 * Rate limits for private result sharing (ADR 0016 R7).
 *
 * Dimensions are safe behind the deployed proxy: per-Clerk-user for
 * owner mutations, per-hashed-IP for public lookups. Raw IPs are never
 * stored — only SHA-256(ip|ua) keys. Redis fixed-window with a Postgres
 * audit_log fallback (same pattern as demo-rate-limit).
 */

export interface ShareRateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
  keyPrefix: string;
}

export const SHARE_RATE_LIMITS: {
  create: ShareRateLimitConfig;
  revoke: ShareRateLimitConfig;
  lookup: ShareRateLimitConfig;
  tokenFailure: ShareRateLimitConfig;
} = {
  create: { windowSeconds: 3600, maxRequests: 10, keyPrefix: "share:create" },
  revoke: { windowSeconds: 3600, maxRequests: 30, keyPrefix: "share:revoke" },
  lookup: { windowSeconds: 60, maxRequests: 60, keyPrefix: "share:lookup" },
  tokenFailure: { windowSeconds: 300, maxRequests: 10, keyPrefix: "share:tokenfail" },
};

export function hashShareRateLimitKey(ip: string | null, userAgent: string | null): string {
  return createHash("sha256")
    .update(`${ip ?? "unknown"}|${userAgent ?? "unknown"}`)
    .digest("hex");
}

export async function checkShareRateLimit(
  key: string,
  config: ShareRateLimitConfig,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const client = getCacheClient();
  // No Redis configured (or outage swallowed as miss/no-op by the cache
  // contract): count in Postgres so limits still hold. Production keeps the
  // fast Redis path; tests and degraded environments get correctness.
  if (client instanceof NoopCacheClient) return checkShareRateLimitPostgres(key, config);
  const redisKey = `${config.keyPrefix}:${key}`;
  try {
    const current = await client.get<number>(redisKey);
    if (current !== null && current > 0) {
      if (current >= config.maxRequests) {
        return { allowed: false, retryAfterSeconds: config.windowSeconds };
      }
      await client.set(redisKey, current + 1, config.windowSeconds);
      return { allowed: true };
    }
    await client.set(redisKey, 1, config.windowSeconds);
    return { allowed: true };
  } catch {
    return checkShareRateLimitPostgres(key, config);
  }
}

async function checkShareRateLimitPostgres(
  key: string,
  config: ShareRateLimitConfig,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const since = new Date(Date.now() - config.windowSeconds * 1000);
  const action = `share.ratelimit:${config.keyPrefix}`;
  const count = await prisma.auditLog.count({
    where: { action, entityId: key, createdAt: { gte: since } },
  });
  if (count >= config.maxRequests) {
    return { allowed: false, retryAfterSeconds: config.windowSeconds };
  }
  await prisma.auditLog.create({
    data: {
      actorId: null,
      action,
      entityType: "share_ratelimit",
      entityId: key,
      beforeJson: Prisma.JsonNull,
      afterJson: { count: count + 1, windowSeconds: config.windowSeconds },
      traceId: crypto.randomUUID(),
    },
  });
  return { allowed: true };
}
