import type { NextRequest, NextResponse } from "next/server";
import {
  draftErrorToProblem,
  ok,
  problem,
  problems,
  requireUserId,
  type RouteContext,
} from "@/lib/api/draft-route-helpers";
import { transitionStatus } from "@/lib/server/drafts";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    const result = await transitionStatus({ draftId: id, ownerId: userId, action: "start" });
    return ok(result);
  } catch (error) {
    const mapped = draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[drafts] start failed", error);
    return problem(problems.internal());
  }
}
