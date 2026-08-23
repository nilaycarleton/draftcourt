import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@draftcourt/db";
import { createOverride, listOverrides, revokeOverride } from "@/lib/server/admin-overrides";
import { createSignal, expireSignal, listSignals } from "@/lib/server/admin-signals";
import { listAuditLog } from "@/lib/server/audit-log";

/**
 * Runs against the real local Postgres (same DB the dev server + demo
 * ingestion use) rather than a mock — the same choice already made
 * throughout Phase 1's Python-side tests. Every row this file creates is
 * cleaned up in `afterAll`.
 */
describe("admin overrides, signals, and audit log", () => {
  let adminId: string;
  let playerId: string;
  const createdOverrideIds: string[] = [];
  const createdSignalIds: string[] = [];

  beforeAll(async () => {
    const player = await prisma.player.findFirstOrThrow({ select: { id: true } });
    playerId = player.id;

    const admin = await prisma.user.create({
      data: {
        clerkUserId: `test-admin-${crypto.randomUUID()}`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ entityId: { in: createdOverrideIds } }, { entityId: { in: createdSignalIds } }],
      },
    });
    await prisma.projectionOverride.deleteMany({ where: { id: { in: createdOverrideIds } } });
    await prisma.playerNewsSignal.deleteMany({ where: { id: { in: createdSignalIds } } });
    await prisma.user.delete({ where: { id: adminId } });
  });

  it("creates a deltaValue override and writes an audit log entry", async () => {
    const result = await createOverride({
      adminId,
      playerId,
      season: "2026-27",
      stat: "pts",
      deltaValue: 2.5,
      replacementValue: null,
      rationale: "Test: confirmed increased offensive role.",
      effectiveAt: new Date(),
      expiresAt: null,
      traceId: crypto.randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdOverrideIds.push(result.override.id);

    expect(result.override.status).toBe("ACTIVE");
    expect(result.override.deltaValue).toBe(2.5);
    expect(result.override.replacementValue).toBeNull();

    const entries = await listAuditLog({
      entityType: "ProjectionOverride",
      entityId: result.override.id,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("projection_override.create");
    expect(entries[0]?.actorId).toBe(adminId);
    expect(entries[0]?.beforeJson).toBeNull();
  });

  it("rejects a delta+replacement value pair at the database CHECK constraint", async () => {
    // admin-overrides.ts trusts its caller (the route's Zod schema already
    // enforces "exactly one"); this proves the DB-level backstop
    // (projection_overrides_value_xor_check) still holds independently.
    await expect(
      prisma.projectionOverride.create({
        data: {
          adminId,
          playerId,
          season: "2026-27",
          stat: "pts",
          deltaValue: 1,
          replacementValue: 30,
          rationale: "Should be rejected by the DB.",
          effectiveAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a blank rationale at the database CHECK constraint", async () => {
    await expect(
      prisma.projectionOverride.create({
        data: {
          adminId,
          playerId,
          season: "2026-27",
          stat: "pts",
          deltaValue: 1,
          rationale: "   ",
          effectiveAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("supersede: creating a replacement marks the prior override SUPERSEDED", async () => {
    const first = await createOverride({
      adminId,
      playerId,
      season: "2026-27",
      stat: "reb",
      deltaValue: 1,
      replacementValue: null,
      rationale: "Test: initial role bump.",
      effectiveAt: new Date(),
      expiresAt: null,
      traceId: crypto.randomUUID(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    createdOverrideIds.push(first.override.id);

    const second = await createOverride({
      adminId,
      playerId,
      season: "2026-27",
      stat: "reb",
      deltaValue: 2,
      replacementValue: null,
      rationale: "Test: revised estimate.",
      effectiveAt: new Date(),
      expiresAt: null,
      supersedesId: first.override.id,
      traceId: crypto.randomUUID(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    createdOverrideIds.push(second.override.id);
    expect(second.override.supersedesId).toBe(first.override.id);

    const overrides = await listOverrides({ playerId });
    const priorRow = overrides.find((o) => o.id === first.override.id);
    expect(priorRow?.status).toBe("SUPERSEDED");
  });

  it("refuses to supersede an override that isn't ACTIVE", async () => {
    const base = await createOverride({
      adminId,
      playerId,
      season: "2026-27",
      stat: "ast",
      deltaValue: 1,
      replacementValue: null,
      rationale: "Test: base for revoke.",
      effectiveAt: new Date(),
      expiresAt: null,
      traceId: crypto.randomUUID(),
    });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    createdOverrideIds.push(base.override.id);

    await revokeOverride({ id: base.override.id, adminId, traceId: crypto.randomUUID() });

    const attempt = await createOverride({
      adminId,
      playerId,
      season: "2026-27",
      stat: "ast",
      deltaValue: 1,
      replacementValue: null,
      rationale: "Test: should fail, base already revoked.",
      effectiveAt: new Date(),
      expiresAt: null,
      supersedesId: base.override.id,
      traceId: crypto.randomUUID(),
    });
    expect(attempt.ok).toBe(false);
  });

  it("revoke sets status REVOKED and logs a before/after audit entry", async () => {
    const created = await createOverride({
      adminId,
      playerId,
      season: "2026-27",
      stat: "blk",
      deltaValue: 0.2,
      replacementValue: null,
      rationale: "Test: to be revoked.",
      effectiveAt: new Date(),
      expiresAt: null,
      traceId: crypto.randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdOverrideIds.push(created.override.id);

    const revoked = await revokeOverride({
      id: created.override.id,
      adminId,
      traceId: crypto.randomUUID(),
    });
    expect(revoked?.status).toBe("REVOKED");

    const entries = await listAuditLog({
      entityType: "ProjectionOverride",
      entityId: created.override.id,
    });
    const revokeEntry = entries.find((e) => e.action === "projection_override.revoke");
    expect(revokeEntry).toBeDefined();
    expect((revokeEntry?.beforeJson as { status?: string } | null)?.status).toBe("ACTIVE");
    expect((revokeEntry?.afterJson as { status?: string } | null)?.status).toBe("REVOKED");
  });

  it("revoke returns null for an unknown id", async () => {
    const result = await revokeOverride({
      id: "00000000-0000-4000-8000-000000000000",
      adminId,
      traceId: crypto.randomUUID(),
    });
    expect(result).toBeNull();
  });

  it("creates a player news signal and expiring it sets expiresAt", async () => {
    const signal = await createSignal({
      adminId,
      playerId,
      type: "ROLE_UP",
      impact: 0.4,
      confidence: 0.7,
      rationale: "Test: starter confirmed.",
      effectiveAt: new Date(),
      expiresAt: null,
      traceId: crypto.randomUUID(),
    });
    createdSignalIds.push(signal.id);
    expect(signal.adminApproved).toBe(true);
    expect(signal.expiresAt).toBeNull();

    const active = await listSignals({ playerId, activeOnly: true });
    expect(active.some((s) => s.id === signal.id)).toBe(true);

    const expired = await expireSignal({ id: signal.id, adminId, traceId: crypto.randomUUID() });
    expect(expired?.expiresAt).not.toBeNull();

    const stillActive = await listSignals({ playerId, activeOnly: true });
    expect(stillActive.some((s) => s.id === signal.id)).toBe(false);
  });
});
