import type { NextRequest, NextResponse } from "next/server";
import {
  draftErrorToProblem,
  ok,
  problem,
  problems,
  requireUserId,
  type RouteContext,
} from "@/lib/api/draft-route-helpers";
import {
  listEventsForOwner,
  listTimelineEventsForOwner,
  TimelineValidationError,
} from "@/lib/server/drafts";

export const dynamic = "force-dynamic";

function parseCursor(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TimelineValidationError("cursor must be an integer sequence >= 0");
  }
  return parsed;
}

function parseLimit(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new TimelineValidationError("limit must be an integer between 1 and 100");
  }
  return parsed;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    const url = new URL(request.url);
    const hasCursorParams = url.searchParams.has("cursor") || url.searchParams.has("limit");

    // Legacy shape (no query params): full ordered array, unchanged for
    // existing callers. Cursor shape: paginated timeline with integrity.
    if (!hasCursorParams) {
      const result = await listEventsForOwner(id, userId);
      if (!result) return problem(problems.notFound("draft not found"));
      return ok(result.events);
    }

    const cursor = parseCursor(url.searchParams.get("cursor"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const page = await listTimelineEventsForOwner(id, userId, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!page) return problem(problems.notFound("draft not found"));
    return ok(page);
  } catch (error) {
    if (error instanceof TimelineValidationError) {
      return problem(problems.validation({ cursor: [error.message] }, error.message));
    }
    const mapped = draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[drafts] events failed", error);
    return problem(problems.internal());
  }
}
