import type { NextRequest, NextResponse } from "next/server";
import { ok, problem, problems } from "@/lib/api/envelope";
import { newTraceId } from "@/lib/api/envelope";
import {
  getDemoDraftState,
  DemoExpiredError,
  DemoRevokedError,
  DemoNotFoundError,
  DemoCapabilityInvalidError,
} from "@/lib/server/demo-drafts";

export const dynamic = "force-dynamic";

/**
 * Resume/read a guest demo draft state (Phase 3D).
 *
 * Authorization: capability token via cookie or Authorization: Bearer header.
 * No Clerk authentication — purely capability-based.
 * Enumeration resistant: all errors return generic 401/404.
 */
function extractCapabilityToken(request: NextRequest): string | null {
  // Check cookie first
  const cookieToken = request.cookies.get("__Secure-demo-capability")?.value;
  if (cookieToken) return cookieToken;

  // Check Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return null;
}

function errorToProblem(error: unknown): NextResponse | null {
  if (error instanceof DemoExpiredError) {
    return problem({
      type: "/problems/demo-expired",
      title: "Demo Expired",
      status: 401,
      detail: `This demo draft expired at ${error.expiresAt.toISOString()}`,
      authoritative: { expiresAt: error.expiresAt.toISOString() },
    });
  }
  if (error instanceof DemoRevokedError) {
    return problem({
      type: "/problems/demo-revoked",
      title: "Demo Revoked",
      status: 401,
      detail: "This demo draft has been abandoned",
    });
  }
  if (error instanceof DemoNotFoundError || error instanceof DemoCapabilityInvalidError) {
    // Enumeration resistant: same response for not found / invalid capability
    return problem({
      type: "/problems/demo-unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid or expired demo capability",
    });
  }
  return null;
}

export async function GET(
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
      detail: "Demo capability token required (cookie or Authorization header)",
    });
  }

  try {
    const state = await getDemoDraftState(id, capabilityToken);
    return ok(state, { traceId });
  } catch (error) {
    const mapped = errorToProblem(error);
    if (mapped) return mapped;
    console.error("[demo-drafts] get failed", error);
    return problem(problems.internal());
  }
}
