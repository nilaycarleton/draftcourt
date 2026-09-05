import type { NextRequest, NextResponse } from "next/server";
import { ok, problem, problems } from "@/lib/api/envelope";
import { newTraceId } from "@/lib/api/envelope";
import { writeAuditLog } from "@/lib/server/audit-log";
import type { CreateDemoDraftInput } from "@/lib/server/demo-drafts";
import {
  createDemoDraft,
  DEMO_CAPABILITY_COOKIE,
  DEMO_LIFETIME_HOURS,
} from "@/lib/server/demo-drafts";

export const dynamic = "force-dynamic";

/**
 * Create a guest demo draft (Phase 3D).
 *
 * Public endpoint — no authentication required.
 * Returns the draft ID, capability token (once), and sets a secure HttpOnly cookie.
 * Rate limited by hashed IP fingerprint.
 */
function errorToProblem(error: unknown): NextResponse | null {
  if (error instanceof Error) {
    if (error.message.includes("rate limit")) {
      return problem({
        type: "/problems/rate-limited",
        title: "Too Many Requests",
        status: 429,
        detail: "Demo creation rate limit reached; try again later",
      });
    }
    if (error.message.includes("Unknown demo preset")) {
      return problem(problems.badRequest("Invalid demo preset"));
    }
    if (error.message.includes("seed") || error.message.includes("personality")) {
      return problem(problems.badRequest(error.message));
    }
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = newTraceId();
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const clientUserAgent = request.headers.get("user-agent") ?? null;

  let body: CreateDemoDraftInput;
  try {
    body = (await request.json()) as CreateDemoDraftInput;
  } catch {
    return problem(problems.badRequest("Invalid JSON body"));
  }

  // Validate required fields
  const validPresets = ["standard", "categories", "dynasty"] as const;
  const presetKey = body.presetKey;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation of user input
  if (!presetKey || !validPresets.includes(presetKey)) {
    return problem(
      problems.badRequest("Invalid or missing presetKey (standard, categories, dynasty)"),
    );
  }

  try {
    const result = await createDemoDraft(body, clientIp, clientUserAgent);

    // Set secure HttpOnly cookie with the capability token
    const maxAge = DEMO_LIFETIME_HOURS * 60 * 60;
    const cookieValue = `${DEMO_CAPABILITY_COOKIE}=${result.capabilityToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${String(maxAge)}`;

    // Redacted audit log
    await writeAuditLog({
      actorId: null,
      action: "demo.draft.create",
      entityType: "demo_draft",
      entityId: result.draftId,
      before: null,
      after: { presetKey: body.presetKey, simulationSeed: result.state.simulationSeed },
      traceId,
    });

    const response = ok(
      {
        draftId: result.draftId,
        capabilityToken: result.capabilityToken, // returned once for copy-paste recovery
        expiresAt: result.expiresAt.toISOString(),
        state: result.state,
      },
      { traceId },
    );
    response.headers.set("Set-Cookie", cookieValue);
    return response;
  } catch (error) {
    const mapped = errorToProblem(error);
    if (mapped) return mapped;
    console.error("[demo-drafts] create failed", error);
    return problem(problems.internal());
  }
}
