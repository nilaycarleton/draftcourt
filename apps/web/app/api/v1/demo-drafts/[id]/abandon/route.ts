import type { NextRequest, NextResponse } from "next/server";
import { ok, problem, problems } from "@/lib/api/envelope";
import { newTraceId } from "@/lib/api/envelope";
import {
  abandonDemoDraft,
  DemoCapabilityInvalidError,
  DemoExpiredError,
  DemoRevokedError,
  DemoNotFoundError,
} from "@/lib/server/demo-drafts";
import { writeAuditLog } from "@/lib/server/audit-log";

export const dynamic = "force-dynamic";

/**
 * Abandon a guest demo draft (Phase 3D).
 *
 * Revokes the capability token and marks the draft as ABANDONED.
 * No If-Match required since this is a one-way destructive action.
 */
function extractCapabilityToken(request: NextRequest): string | null {
  const cookieToken = request.cookies.get("__Secure-demo-capability")?.value;
  if (cookieToken) return cookieToken;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  return null;
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
      detail: "Demo already abandoned",
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

  try {
    await abandonDemoDraft({ draftId: id, capabilityToken });

    await writeAuditLog({
      actorId: null,
      action: "demo.draft.abandon",
      entityType: "demo_draft",
      entityId: id,
      before: null,
      after: { abandoned: true },
      traceId,
    });

    // Clear the capability cookie
    const response = ok({ abandoned: true }, { traceId });
    response.headers.set(
      "Set-Cookie",
      "__Secure-demo-capability=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
    return response;
  } catch (error) {
    const mapped = errorToProblem(error);
    if (mapped) return mapped;
    console.error("[demo-drafts] abandon failed", error);
    return problem(problems.internal());
  }
}
