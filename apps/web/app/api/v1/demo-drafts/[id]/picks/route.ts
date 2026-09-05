/* eslint-disable @typescript-eslint/no-unnecessary-condition -- version-conflict shape checks are runtime-only */
import type { NextRequest, NextResponse } from "next/server";
import { ok, problem, problems } from "@/lib/api/envelope";
import { newTraceId } from "@/lib/api/envelope";
import {
  makeDemoUserPick,
  DemoCapabilityInvalidError,
  DemoExpiredError,
  DemoRevokedError,
  DemoNotFoundError,
} from "@/lib/server/demo-drafts";
import { writeAuditLog } from "@/lib/server/audit-log";
import type { AuthoritativeState } from "@/lib/server/drafts";

export const dynamic = "force-dynamic";

/**
 * Guest user pick in a demo draft (Phase 3D).
 *
 * Requires: valid capability token, If-Match, Idempotency-Key.
 * Returns authoritative state after the pick.
 */
function extractCapabilityToken(request: NextRequest): string | null {
  const cookieToken = request.cookies.get("__Secure-demo-capability")?.value;
  if (cookieToken) return cookieToken;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  return null;
}

function requireCapabilityToken(request: NextRequest): string {
  const token = extractCapabilityToken(request);
  if (!token) {
    throw new Error("DEMO_UNAUTHORIZED");
  }
  return token;
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
  // Handle draft-level errors
  if (error instanceof Error) {
    if (
      error.message.includes("not active") ||
      error.message.includes("not your turn") ||
      error.message.includes("already drafted") ||
      error.message.includes("no legal roster") ||
      error.message.includes("retired") ||
      error.message.includes("unsigned") ||
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
  let capabilityToken: string;
  try {
    capabilityToken = requireCapabilityToken(request);
  } catch {
    return problem({
      type: "/problems/demo-unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Demo capability token required",
    });
  }
  const traceId = newTraceId();

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

  let body: { playerId: string };
  try {
    body = (await request.json()) as { playerId: string };
  } catch {
    return problem(problems.badRequest("Invalid JSON body"));
  }

  if (!body.playerId || typeof body.playerId !== "string") {
    return problem(problems.badRequest("playerId is required"));
  }

  try {
    const result = await makeDemoUserPick({
      draftId: id,
      capabilityToken,
      playerId: body.playerId,
      idempotencyKey: idempotencyKey.trim(),
      ifMatchVersion: Number(ifMatch),
    });

    await writeAuditLog({
      actorId: null,
      action: "demo.draft.pick",
      entityType: "demo_draft",
      entityId: id,
      before: null,
      after: { sequence: result.authoritative.currentSequence, playerId: body.playerId },
      traceId,
    });

    return ok(result, { traceId });
  } catch (error) {
    const mapped = errorToProblem(error);
    if (mapped) return mapped;
    console.error("[demo-drafts] user pick failed", error);
    return problem(problems.internal());
  }
}
