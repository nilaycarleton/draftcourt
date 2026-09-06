import type { NextRequest, NextResponse } from "next/server";
import { ok, problem, problems } from "@/lib/api/envelope";
import { requireUserId, draftErrorToProblem } from "@/lib/api/draft-route-helpers";
import {
  getOrGenerateAnalysisForOwner,
  AnalysisNotReadyError,
  AnalysisNotFoundError,
} from "@/lib/server/analysis";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());

  try {
    const { analysis, cached } = await getOrGenerateAnalysisForOwner(id, userId);
    return ok(analysis, { cached });
  } catch (error) {
    if (error instanceof AnalysisNotFoundError) {
      return problem({
        type: "/problems/not-found",
        title: "Not Found",
        status: 404,
        detail: "draft not found",
      });
    }
    if (error instanceof AnalysisNotReadyError) {
      return problem({
        type: "/problems/draft-not-ready",
        title: "Draft Not Ready",
        status: 409,
        detail: error.message,
      });
    }
    const mapped = draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[analysis] get failed", error);
    return problem(problems.internal());
  }
}
