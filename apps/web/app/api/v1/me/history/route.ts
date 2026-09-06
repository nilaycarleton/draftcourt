/* eslint-disable @typescript-eslint/no-unnecessary-condition -- guarded local redis check */
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ok, problem, problems } from "@/lib/api/envelope";
import { requireUserId, zodIssues } from "@/lib/api/draft-route-helpers";
import {
  listHistoryForOwner,
  HistoryNotFoundError,
  HistoryValidationError,
} from "@/lib/server/history";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  type: z.enum(["REAL", "MOCK"]).optional(),
  status: z.enum(["SETUP", "ACTIVE", "PAUSED", "COMPLETED", "ABANDONED"]).optional(),
  leagueId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());

  const url = new URL(request.url);
  const raw = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    leagueId: url.searchParams.get("leagueId") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };

  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return problem(problems.validation(zodIssues(parsed.error)));
  }

  try {
    const result = await listHistoryForOwner(userId, {
      ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.type ? { type: parsed.data.type } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.leagueId ? { leagueId: parsed.data.leagueId } : {}),
      ...(parsed.data.from ? { from: parsed.data.from } : {}),
      ...(parsed.data.to ? { to: parsed.data.to } : {}),
    });
    return ok(result);
  } catch (error) {
    if (error instanceof HistoryNotFoundError) {
      return problem({
        type: "/problems/not-found",
        title: "Not Found",
        status: 404,
        detail: "league not found",
      });
    }
    if (error instanceof HistoryValidationError) {
      return problem(problems.badRequest(error.message));
    }
    console.error("[history] list failed", error);
    return problem(problems.internal());
  }
}
