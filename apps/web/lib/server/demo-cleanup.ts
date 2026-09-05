import { prisma } from "@draftcourt/db";
import { writeAuditLog } from "./audit-log";
import { newTraceId } from "@/lib/api/envelope";

/**
 * Demo draft cleanup job (Phase 3D).
 *
 * Removes expired demo capabilities and their associated drafts.
 * Runs periodically (e.g., hourly via cron/Inngest).
 * Idempotent: uses advisory lock to prevent concurrent runs.
 * Bounded batch size to avoid long transactions.
 */

const CLEANUP_BATCH_SIZE = 100;
const CLEANUP_ADVISORY_LOCK_KEY = 0xdeadc0de; // arbitrary 32-bit int

export interface CleanupResult {
  scanned: number;
  deletedCapabilities: number;
  deletedDrafts: number;
  errors: string[];
}

/**
 * Run one cleanup batch.
 * Returns counts of processed items.
 */
export async function runDemoCleanupBatch(): Promise<CleanupResult> {
  const result: CleanupResult = {
    scanned: 0,
    deletedCapabilities: 0,
    deletedDrafts: 0,
    errors: [],
  };

  // Try to acquire advisory lock (non-blocking)
  const lockAcquired = await prisma.$queryRaw<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${CLEANUP_ADVISORY_LOCK_KEY}) AS acquired
  `.then((rows) => rows[0]?.acquired ?? false);

  if (!lockAcquired) {
    result.errors.push("Could not acquire cleanup lock; another run may be in progress");
    return result;
  }

  try {
    // Find expired capabilities (not yet revoked)
    const expiredCapabilities = await prisma.demoDraftCapability.findMany({
      where: {
        expiresAt: { lt: new Date() },
        revokedAt: null,
      },
      select: { id: true, draftId: true },
      take: CLEANUP_BATCH_SIZE,
      orderBy: { expiresAt: "asc" },
    });

    result.scanned = expiredCapabilities.length;

    for (const cap of expiredCapabilities) {
      try {
        await cleanupSingleDemo(cap.draftId, cap.id);
        result.deletedCapabilities++;
        result.deletedDrafts++;
      } catch (error) {
        result.errors.push(
          `Failed to clean demo ${cap.draftId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    // Release lock
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${CLEANUP_ADVISORY_LOCK_KEY})`;
  }

  return result;
}

/**
 * Clean up a single demo draft and its capability.
 * Deletes in correct order to respect foreign keys.
 */
async function cleanupSingleDemo(draftId: string, capabilityId: string): Promise<void> {
  return prisma.$transaction(async (tx) => {
    // Delete dependent records first (in correct order). Capability must be deleted before draft
    // because the capability's FK to draft is CASCADE, but draft also has a FK to capability with SET NULL;
    // deleting capability first avoids the cascade-deleted-row error.
    await tx.draftRosterAssignment.deleteMany({ where: { draftId } });
    await tx.draftEvent.deleteMany({ where: { draftId } });
    await tx.recommendationSnapshot.deleteMany({ where: { draftId } });
    await tx.draftOutbox.deleteMany({ where: { draftId } });
    await tx.draftTeam.deleteMany({ where: { draftId } });
    await tx.demoDraftCapability.delete({ where: { id: capabilityId } });
    await tx.draft.delete({ where: { id: draftId } });
  });
}

/**
 * Scheduled cleanup entry point for Inngest/cron.
 * Logs results to audit log.
 */
export async function runScheduledDemoCleanup(): Promise<void> {
  const traceId = newTraceId();
  const startTime = Date.now();

  const result = await runDemoCleanupBatch();

  await writeAuditLog({
    actorId: null,
    action: "demo.cleanup.run",
    entityType: "demo_cleanup",
    entityId: "batch",
    before: null,
    after: {
      scanned: result.scanned,
      deletedCapabilities: result.deletedCapabilities,
      deletedDrafts: result.deletedDrafts,
      durationMs: Date.now() - startTime,
      errors: result.errors,
    },
    traceId,
  });

  if (result.errors.length > 0) {
    console.warn("[demo-cleanup] completed with errors", result.errors);
  }
}
