import type { NextRequest, NextResponse } from "next/server";
import {
  draftErrorToProblem,
  ok,
  problem,
  problems,
  requireUserId,
  type RouteContext,
} from "@/lib/api/draft-route-helpers";
import { listEventsForOwner } from "@/lib/server/drafts";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    const result = await listEventsForOwner(id, userId);
    if (!result) return problem(problems.notFound("draft not found"));
    return ok(result.events);
  } catch (error) {
    const mapped = draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[drafts] events failed", error);
    return problem(problems.internal());
  }
}
