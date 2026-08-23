import type { NextRequest, NextResponse } from "next/server";
import { ok, problem, problems } from "@/lib/api/envelope";
import { CURRENT_SEASON } from "@/lib/server/current-run";
import { encodeCursor, listPlayers } from "@/lib/server/players";
import {
  playersQuerySchema,
  toPlayerListQuery,
  zodIssuesToFieldErrors,
} from "@/lib/server/players-query";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rawParams = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = playersQuerySchema.safeParse(rawParams);
  if (!parsed.success) {
    return problem(problems.validation(zodIssuesToFieldErrors(parsed.error.issues)));
  }

  const result = await listPlayers(toPlayerListQuery(parsed.data));

  return ok(result.players, {
    season: CURRENT_SEASON,
    totalCount: result.totalCount,
    nextCursor: result.nextCursor !== null ? encodeCursor(result.nextCursor) : null,
    hasMore: result.hasMore,
    projectionRunId: result.meta.runId,
    modelVersion: result.meta.modelVersion,
    dataCutoff: result.meta.dataCutoff,
    adpSnapshotCapturedAt: result.meta.adpSnapshotCapturedAt,
    demoData: true,
  });
}
