import type { NextRequest, NextResponse } from "next/server";
import { ok } from "@/lib/api/envelope";
import { requireAdminOrProblem } from "@/lib/api/admin-guard";
import { listAuditLog } from "@/lib/server/audit-log";
import { compact } from "@/lib/compact";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdminOrProblem();
  if ("response" in guard) return guard.response;

  const { searchParams } = new URL(request.url);
  const limitParam = searchParams.get("limit");
  const entries = await listAuditLog(
    compact({
      entityType: searchParams.get("entityType") ?? undefined,
      entityId: searchParams.get("entityId") ?? undefined,
      limit: limitParam ? Number(limitParam) : undefined,
    }),
  );
  return ok(entries);
}
