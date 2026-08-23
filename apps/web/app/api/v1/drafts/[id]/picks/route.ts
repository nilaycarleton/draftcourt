import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  draftErrorToProblem,
  ok,
  problem,
  problems,
  requireUserId,
  zodIssues,
  type RouteContext,
} from "@/lib/api/draft-route-helpers";
import { makePick } from "@/lib/server/drafts";

export const dynamic = "force-dynamic";

const pickSchema = z.object({
  playerId: z.uuid(),
});

/**
 * POST /api/v1/drafts/:id/picks — append a pick event.
 * Requires `Idempotency-Key` (safe retry/redelivery) and `If-Match: <version>`
 * (optimistic concurrency). 409 responses carry the authoritative state.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return problem(
      problems.badRequest("Idempotency-Key header (8-128 chars) is required for pick mutations"),
    );
  }
  const ifMatch = request.headers.get("If-Match");
  if (!ifMatch) {
    return problem(
      problems.badRequest("If-Match header with the current draft version is required"),
    );
  }
  const version = Number(ifMatch);
  if (!Number.isInteger(version) || version < 0) {
    return problem(problems.badRequest("If-Match must be the integer draft version"));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(problems.badRequest("request body must be JSON"));
  }
  const parsed = pickSchema.safeParse(body);
  if (!parsed.success) {
    return problem(problems.validation(zodIssues(parsed.error)));
  }

  try {
    const result = await makePick({
      draftId: id,
      ownerId: userId,
      playerId: parsed.data.playerId,
      idempotencyKey,
      ifMatchVersion: version,
    });
    return ok(result, { traceId: crypto.randomUUID() });
  } catch (error) {
    const mapped = draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[drafts] pick failed", error);
    return problem(problems.internal());
  }
}
