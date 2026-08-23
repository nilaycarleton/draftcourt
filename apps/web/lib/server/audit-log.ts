import { prisma, Prisma } from "@draftcourt/db";

/** Every admin mutation writes one row here — before/after must already be
 * a safe, serializable snapshot (never a raw Prisma error, secret, or
 * unredacted request body) by the time it reaches this function. Typed as
 * `object` (not `Record<string, unknown>`) so a plain interface value —
 * which TS doesn't structurally match to an index-signatured type — can be
 * passed straight through without a cast at every call site. */
export async function writeAuditLog(entry: {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: object | null;
  after: object | null;
  traceId: string;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeJson: entry.before === null ? Prisma.JsonNull : (entry.before as Prisma.InputJsonValue),
      afterJson: entry.after === null ? Prisma.JsonNull : (entry.after as Prisma.InputJsonValue),
      traceId: entry.traceId,
    },
  });
}

export interface AdminAuditLogView {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
  traceId: string;
  createdAt: string;
}

export async function listAuditLog(filters: {
  entityType?: string;
  entityId?: string;
  limit?: number;
}): Promise<AdminAuditLogView[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
    },
    include: { actor: { select: { role: true } } },
    orderBy: { createdAt: "desc" },
    take: Math.min(filters.limit ?? 50, 200),
  });

  return rows.map((row) => ({
    id: row.id,
    actorId: row.actorId,
    actorRole: row.actor?.role ?? null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeJson: row.beforeJson,
    afterJson: row.afterJson,
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString(),
  }));
}
