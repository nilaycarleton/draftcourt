import { prisma } from "@draftcourt/db";
import { writeAuditLog } from "./audit-log";
import { newTraceId } from "@/lib/api/envelope";

/**
 * Share-capability cleanup job (ADR 0016 R5, Phase 3E2 M7).
 *
 * Deletes expired share rows and long-revoked rows (revoked > 7 days ago)
 * in bounded batches. Never touches drafts, analyses, events, history, or
 * demo/guest rows. Idempotent, advisory-locked, safe concurrently with
 * public reads (single-row deletes, no table locks). Reports redacted
 * counts and timing only — never tokens, digests, or owner data.
 */

export const SHARE_CLEANUP_BATCH_SIZE = 100;
const SHARE_CLEANUP_ADVISORY_LOCK_KEY = 0x57a12e; // distinct from demo cleanup
const REVOKED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ShareCleanupResult {
  scanned: number;
  deletedExpired: number;
  deletedRevoked: number;
  errors: string[];
  durationMs: number;
}

export async function runShareCleanupBatch(): Promise<ShareCleanupResult> {
  const start = Date.now();
  const result: ShareCleanupResult = {
    scanned: 0,
    deletedExpired: 0,
    deletedRevoked: 0,
    errors: [],
    durationMs: 0,
  };

  const lockAcquired = await prisma.$queryRaw<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${SHARE_CLEANUP_ADVISORY_LOCK_KEY}) AS acquired
  `.then((rows) => rows[0]?.acquired ?? false);

  if (!lockAcquired) {
    result.errors.push("Could not acquire share cleanup lock; another run may be in progress");
    result.durationMs = Date.now() - start;
    return result;
  }

  try {
    const now = new Date();
    const candidates = await prisma.draftShareCapability.findMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { revokedAt: { lt: new Date(now.getTime() - REVOKED_GRACE_MS) } },
        ],
      },
      select: { id: true, expiresAt: true, revokedAt: true },
      take: SHARE_CLEANUP_BATCH_SIZE,
      orderBy: { expiresAt: "asc" },
    });

    result.scanned = candidates.length;
    for (const row of candidates) {
      try {
        await prisma.draftShareCapability.delete({ where: { id: row.id } });
        if (row.revokedAt !== null) result.deletedRevoked += 1;
        else result.deletedExpired += 1;
      } catch (error) {
        result.errors.push(
          `Failed to clean share row: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${SHARE_CLEANUP_ADVISORY_LOCK_KEY})`;
    result.durationMs = Date.now() - start;
  }

  return result;
}

export async function runScheduledShareCleanup(): Promise<void> {
  const traceId = newTraceId();
  const result = await runShareCleanupBatch();
  await writeAuditLog({
    actorId: null,
    action: "share.cleanup.run",
    entityType: "share_cleanup",
    entityId: "batch",
    before: null,
    after: {
      scanned: result.scanned,
      deletedExpired: result.deletedExpired,
      deletedRevoked: result.deletedRevoked,
      durationMs: result.durationMs,
      errors: result.errors,
    },
    traceId,
  });
}
