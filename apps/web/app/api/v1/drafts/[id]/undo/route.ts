import type { NextRequest, NextResponse } from "next/server";
import {
  draftErrorToProblem,
  ok,
  problem,
  problems,
  requireUserId,
  type RouteContext,
} from "@/lib/api/draft-route-helpers";
import { undoPick } from "@/lib/server/drafts";

export const dynamic = "force-dynamic";

/** POST /api/v1/drafts/:id/undo — compensating PICK_UNDONE of the latest
 * effective pick. Same Idempotency-Key / If-Match contract as picks. */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return problem(
      problems.badRequest("Idempotency-Key header (8-128 chars) is required for undo"),
    );
  }
  const ifMatch = request.headers.get("If-Match");
  if (!ifMatch) return problem(problems.badRequest("If-Match header is required"));
  const version = Number(ifMatch);
  if (!Number.isInteger(version) || version < 0) {
    return problem(problems.badRequest("If-Match must be the integer draft version"));
  }

  try {
    const result = await undoPick({
      draftId: id,
      ownerId: userId,
      idempotencyKey,
      ifMatchVersion: version,
    });
    return ok(result);
  } catch (error) {
    const mapped = draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[drafts] undo failed", error);
    return problem(problems.internal());
  }
}
