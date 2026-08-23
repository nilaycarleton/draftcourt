import type { NextRequest, NextResponse } from "next/server";
import {
  draftErrorToProblem,
  ok,
  problem,
  problems,
  requireUserId,
  type RouteContext,
} from "@/lib/api/draft-route-helpers";
import { DraftNotReadyError, getRecommendationsForOwner } from "@/lib/server/recommendations";

export const dynamic = "force-dynamic";

/** GET /api/v1/drafts/:id/recommendations — top 3 + full pool at the current
 * sequence. Cached by (sequence, input checksum); recomputes when the board
 * moved or projections changed. */
export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    const result = await getRecommendationsForOwner(id, userId);
    if (!result) return problem(problems.notFound("draft not found"));
    return ok(result.output, {
      latencyMs: result.latencyMs,
      cached: result.cached,
      engineVersion: result.output.engineVersion,
      inputChecksum: result.output.inputChecksum,
    });
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
    console.error("[recommendations] failed", error);
    return problem(problems.internal());
  }
}
