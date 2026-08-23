import { prisma } from "@draftcourt/db";
import type { Prisma } from "@draftcourt/db";
import { writeAuditLog } from "./audit-log";

export interface AdminSignalView {
  id: string;
  playerId: string;
  playerName: string;
  type: string;
  impact: number;
  confidence: number;
  rationale: string | null;
  adminApproved: boolean;
  effectiveAt: string;
  expiresAt: string | null;
  createdAt: string;
}

type SignalRow = Prisma.PlayerNewsSignalGetPayload<{
  include: { player: { select: { displayName: true } } };
}>;

function serialize(row: SignalRow): AdminSignalView {
  return {
    id: row.id,
    playerId: row.playerId,
    playerName: row.player.displayName,
    type: row.type,
    impact: row.impact,
    confidence: row.confidence,
    rationale: row.rationale,
    adminApproved: row.adminApproved,
    effectiveAt: row.effectiveAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const INCLUDE = {
  player: { select: { displayName: true } },
} satisfies Prisma.PlayerNewsSignalInclude;

export async function listSignals(filters: {
  playerId?: string;
  activeOnly?: boolean;
}): Promise<AdminSignalView[]> {
  const rows = await prisma.playerNewsSignal.findMany({
    where: {
      ...(filters.playerId ? { playerId: filters.playerId } : {}),
      ...(filters.activeOnly
        ? { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }
        : {}),
    },
    include: INCLUDE,
    orderBy: { effectiveAt: "desc" },
    take: 200,
  });
  return rows.map(serialize);
}

export interface CreateSignalInput {
  adminId: string;
  playerId: string;
  type: string;
  impact: number;
  confidence: number;
  rationale: string | null;
  effectiveAt: Date;
  expiresAt: Date | null;
  traceId: string;
}

export async function createSignal(input: CreateSignalInput): Promise<AdminSignalView> {
  const created = await prisma.playerNewsSignal.create({
    data: {
      playerId: input.playerId,
      type: input.type as never,
      impact: input.impact,
      confidence: input.confidence,
      rationale: input.rationale,
      adminApproved: true,
      createdById: input.adminId,
      effectiveAt: input.effectiveAt,
      expiresAt: input.expiresAt,
    },
    include: INCLUDE,
  });

  await writeAuditLog({
    actorId: input.adminId,
    action: "player_news_signal.create",
    entityType: "PlayerNewsSignal",
    entityId: created.id,
    before: null,
    after: serialize(created),
    traceId: input.traceId,
  });

  return serialize(created);
}

export async function expireSignal(input: {
  id: string;
  adminId: string;
  traceId: string;
}): Promise<AdminSignalView | null> {
  const existing = await prisma.playerNewsSignal.findUnique({
    where: { id: input.id },
    include: INCLUDE,
  });
  if (!existing) return null;

  const updated = await prisma.playerNewsSignal.update({
    where: { id: input.id },
    data: { expiresAt: new Date() },
    include: INCLUDE,
  });

  await writeAuditLog({
    actorId: input.adminId,
    action: "player_news_signal.expire",
    entityType: "PlayerNewsSignal",
    entityId: updated.id,
    before: serialize(existing),
    after: serialize(updated),
    traceId: input.traceId,
  });

  return serialize(updated);
}
