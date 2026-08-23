import { prisma } from "@draftcourt/db";
import type { Prisma } from "@draftcourt/db";
import { writeAuditLog } from "./audit-log";
import type { OverridableStat } from "@/lib/shared/admin-constants";

export { OVERRIDABLE_STATS } from "@/lib/shared/admin-constants";
export type { OverridableStat } from "@/lib/shared/admin-constants";

export interface AdminOverrideView {
  id: string;
  playerId: string;
  playerName: string;
  season: string;
  stat: string;
  deltaValue: number | null;
  replacementValue: number | null;
  rationale: string;
  status: string;
  adminId: string;
  supersedesId: string | null;
  effectiveAt: string;
  expiresAt: string | null;
  createdAt: string;
}

type OverrideRow = Prisma.ProjectionOverrideGetPayload<{
  include: { player: { select: { displayName: true } } };
}>;

function serialize(row: OverrideRow): AdminOverrideView {
  return {
    id: row.id,
    playerId: row.playerId,
    playerName: row.player.displayName,
    season: row.season,
    stat: row.stat,
    deltaValue: row.deltaValue !== null ? Number(row.deltaValue) : null,
    replacementValue: row.replacementValue !== null ? Number(row.replacementValue) : null,
    rationale: row.rationale,
    status: row.status,
    adminId: row.adminId,
    supersedesId: row.supersedesId,
    effectiveAt: row.effectiveAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const INCLUDE = {
  player: { select: { displayName: true } },
} satisfies Prisma.ProjectionOverrideInclude;

export async function listOverrides(filters: {
  playerId?: string;
  status?: string;
}): Promise<AdminOverrideView[]> {
  const rows = await prisma.projectionOverride.findMany({
    where: {
      ...(filters.playerId ? { playerId: filters.playerId } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
    },
    include: INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map(serialize);
}

export interface CreateOverrideInput {
  adminId: string;
  playerId: string;
  season: string;
  stat: OverridableStat;
  deltaValue: number | null;
  replacementValue: number | null;
  rationale: string;
  effectiveAt: Date;
  expiresAt: Date | null;
  /** When set, the referenced override is marked SUPERSEDED in the same
   * transaction — history is preserved, never overwritten or deleted. */
  supersedesId?: string;
  traceId: string;
}

export async function createOverride(
  input: CreateOverrideInput,
): Promise<{ ok: true; override: AdminOverrideView } | { ok: false; reason: "not_found" }> {
  const result = await prisma.$transaction(async (tx) => {
    if (input.supersedesId) {
      const prior = await tx.projectionOverride.findUnique({ where: { id: input.supersedesId } });
      if (prior?.status !== "ACTIVE") return null;
    }

    const created = await tx.projectionOverride.create({
      data: {
        adminId: input.adminId,
        playerId: input.playerId,
        season: input.season,
        stat: input.stat,
        deltaValue: input.deltaValue,
        replacementValue: input.replacementValue,
        rationale: input.rationale,
        effectiveAt: input.effectiveAt,
        expiresAt: input.expiresAt,
        ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
      },
      include: INCLUDE,
    });

    if (input.supersedesId) {
      await tx.projectionOverride.update({
        where: { id: input.supersedesId },
        data: { status: "SUPERSEDED" },
      });
    }

    return created;
  });

  if (!result) return { ok: false, reason: "not_found" };

  await writeAuditLog({
    actorId: input.adminId,
    action: input.supersedesId ? "projection_override.supersede" : "projection_override.create",
    entityType: "ProjectionOverride",
    entityId: result.id,
    before: input.supersedesId ? { supersededId: input.supersedesId } : null,
    after: serialize(result),
    traceId: input.traceId,
  });

  return { ok: true, override: serialize(result) };
}

export async function revokeOverride(input: {
  id: string;
  adminId: string;
  traceId: string;
}): Promise<AdminOverrideView | null> {
  const existing = await prisma.projectionOverride.findUnique({
    where: { id: input.id },
    include: INCLUDE,
  });
  if (!existing) return null;

  const updated = await prisma.projectionOverride.update({
    where: { id: input.id },
    data: { status: "REVOKED" },
    include: INCLUDE,
  });

  await writeAuditLog({
    actorId: input.adminId,
    action: "projection_override.revoke",
    entityType: "ProjectionOverride",
    entityId: updated.id,
    before: serialize(existing),
    after: serialize(updated),
    traceId: input.traceId,
  });

  return serialize(updated);
}
