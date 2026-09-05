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
  assertCpuPickRate,
  CpuRateLimitedError,
  CpuTurnError,
  makeCpuPickForOwner,
} from "@/lib/server/cpu-mock";
import { writeAuditLog } from "@/lib/server/audit-log";
import { newTraceId } from "@/lib/api/envelope";

export const dynamic = "force-dynamic";

/**
 * Owner-only CPU pick (Phase 3C, ADR 0013). MOCK + ACTIVE + CPU-turn only.
 * The picking team derives from the authoritative cursor — this endpoint
 * accepts NO player or team input, so arbitrary-player injection is
 * structurally impossible. One authoritative pick per request; duplicate
 * Idempotency-Key deliveries replay the recorded outcome.
 */

function errorToProblem(error: unknown): NextResponse | null {
  if (error instanceof CpuTurnError) {
    return problem({
      type: "/problems/cpu-turn",
      title: "Conflict",
      status: 409,
      detail: error.message,
      authoritative: error.authoritative,
    });
  }
  if (error instanceof CpuRateLimitedError) {
    return problem({
      type: "/problems/rate-limited",
      title: "Too Many Requests",
      status: 429,
      detail: "CPU pick rate limit reached; retry shortly",
    });
  }
  return null;
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  const ifMatch = request.headers.get("If-Match");
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (ifMatch === null || ifMatch.trim() === "") {
    return problem(problems.badRequest("If-Match header is required"));
  }
  const version = Number.parseInt(ifMatch, 10);
  if (!Number.isInteger(version) || version < 0) {
    return problem(problems.badRequest("If-Match must be a non-negative integer version"));
  }
  if (idempotencyKey === null || idempotencyKey.trim() === "" || idempotencyKey.length > 200) {
    return problem(problems.badRequest("Idempotency-Key header is required"));
  }

  try {
    await assertCpuPickRate(userId);
    const result = await makeCpuPickForOwner(id, userId, idempotencyKey.trim(), version);
    // Redacted audit row (ids/keys only — never payloads or seeds beyond the
    // short decision-seed hex already stored on the event).
    await writeAuditLog({
      actorId: userId,
      action: "draft.cpuPick",
      entityType: "draft",
      entityId: id,
      before: null,
      after: { sequence: result.pick.sequence, personalityKey: result.evidence.personalityKey },
      traceId: newTraceId(),
    });
    return ok(result);
  } catch (error) {
    const mapped = errorToProblem(error) ?? draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[drafts] cpu-pick failed", error);
    return problem(problems.internal());
  }
}
