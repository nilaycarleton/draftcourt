/* eslint-disable @typescript-eslint/no-unnecessary-condition -- version-conflict shape checks are runtime-only */
import type { NextRequest, NextResponse } from "next/server";
import { ok, problem, problems } from "@/lib/api/envelope";
import { newTraceId } from "@/lib/api/envelope";
import {
  makeDemoCpuPick,
  DemoCapabilityInvalidError,
  DemoExpiredError,
  DemoRevokedError,
  DemoNotFoundError,
} from "@/lib/server/demo-drafts";
import { writeAuditLog } from "@/lib/server/audit-log";
import type { AuthoritativeState } from "@/lib/server/drafts";

export const dynamic = "force-dynamic";

/**
 * Advance one CPU turn in a guest demo draft (Phase 3D).
 *
 * Requires: valid capability token, If-Match, Idempotency-Key.
 * Returns the CPU pick with decision evidence.
 */
function extractCapabilityToken(request: NextRequest): string | null {
  const cookieToken = request.cookies.get("__Secure-demo-capability")?.value;
  if (cookieToken) return cookieToken;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  return null;
}

interface VersionConflictError extends Error {
  authoritative: AuthoritativeState;
}

function errorToProblem(error: unknown): NextResponse | null {
  if (error instanceof DemoExpiredError) {
    return problem({
      type: "/problems/demo-expired",
      title: "Demo Expired",
      status: 401,
      detail: `Demo expired at ${error.expiresAt.toISOString()}`,
    });
  }
  if (error instanceof DemoRevokedError) {
    return problem({
      type: "/problems/demo-revoked",
      title: "Demo Revoked",
      status: 401,
      detail: "Demo abandoned",
    });
  }
  if (error instanceof DemoNotFoundError || error instanceof DemoCapabilityInvalidError) {
    return problem({
      type: "/problems/demo-unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid or expired demo capability",
    });
  }
  if (
    error instanceof Error &&
    "authoritative" in error &&
    typeof (error as VersionConflictError).authoritative === "object" &&
    (error as VersionConflictError).authoritative !== null
  ) {
    const versionError = error as VersionConflictError;
    return problem({
      type: "/problems/conflict",
      title: "Conflict",
      status: 409,
      detail: error.message,
      authoritative: versionError.authoritative,
    });
  }
  if (error instanceof Error) {
    if (
      error.message.includes("not active") ||
      error.message.includes("user's turn") ||
      error.message.includes("missing immutable") ||
      error.message.includes("concurrently") ||
      error.message.includes("modified")
    ) {
      return problem({
        type: "/problems/conflict",
        title: "Conflict",
        status: 409,
        detail: error.message,
      });
    }
  }
  return null;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const capabilityToken = extractCapabilityToken(request);
  const traceId = newTraceId();

  if (!capabilityToken) {
    return problem({
      type: "/problems/demo-unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Demo capability token required",
    });
  }

  const ifMatch = request.headers.get("If-Match");
  const idempotencyKey = request.headers.get("Idempotency-Key");

  if (!ifMatch || !Number.isInteger(Number(ifMatch)) || Number(ifMatch) < 0) {
    return problem(
      problems.badRequest("If-Match header (non-negative integer version) is required"),
    );
  }
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return problem(problems.badRequest("Idempotency-Key header is required"));
  }

  try {
    const result = await makeDemoCpuPick({
      draftId: id,
      capabilityToken,
      idempotencyKey: idempotencyKey.trim(),
      ifMatchVersion: Number(ifMatch),
    });

    await writeAuditLog({
      actorId: null,
      action: "demo.draft.cpuPick",
      entityType: "demo_draft",
      entityId: id,
      before: null,
      after: {
        sequence: result.authoritative.currentSequence,
        personalityKey: result.evidence.personalityKey,
      },
      traceId,
    });

    return ok(result, { traceId });
  } catch (error) {
    const mapped = errorToProblem(error);
    if (mapped) return mapped;
    console.error("[demo-drafts] cpu pick failed", error);
    return problem(problems.internal());
  }
}
