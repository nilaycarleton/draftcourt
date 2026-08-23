import type { NextRequest, NextResponse } from "next/server";
import {
  draftErrorToProblem,
  ok,
  problem,
  problems,
  requireUserId,
  type RouteContext,
} from "@/lib/api/draft-route-helpers";
import { DraftNotReadyError, recalculateForOwner } from "@/lib/server/recommendations";

export const dynamic = "force-dynamic";

/** POST /api/v1/drafts/:id/recommendations/recalculate — force a fresh
 * snapshot, rate-limited per draft (4 requests / 30s) without Redis. */
export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    const result = await recalculateForOwner(id, userId);
    if (!result.ok) {
      return problem({
        type: "/problems/rate-limited",
        title: "Too Many Requests",
        status: 429,
        detail: "recalculation rate limit reached; retry shortly",
      });
    }
    return ok({ recalculated: true });
  } catch (error) {
    if (error instanceof DraftNotReadyError) {
      return problem({
        type: "/problems/draft-not-ready",
        title: "Not Ready",
        status: 409,
        detail: error.message,
      });
    }
    const mapped = draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[recommendations] recalc failed", error);
    return problem(problems.internal());
  }
}
