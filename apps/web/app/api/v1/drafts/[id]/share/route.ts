import { NextResponse, type NextRequest } from "next/server";
import { problem, problems } from "@/lib/api/envelope";
import { requireUserId } from "@/lib/api/draft-route-helpers";
import {
  createOrRotateShareForOwner,
  revokeShareForOwner,
  ShareNotFoundError,
  ShareNotReadyError,
  ShareValidationError,
} from "@/lib/server/share";
import { checkShareRateLimit, SHARE_RATE_LIMITS } from "@/lib/server/share-rate-limit";

export const dynamic = "force-dynamic";

function shareBaseUrl(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured !== undefined && configured !== "") return configured.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/** POST: owner-only create/rotate for COMPLETED drafts. Returns the raw
 * share URL exactly once — the server never stores or re-emits it. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  const gated = await checkShareRateLimit(`user:${userId}`, SHARE_RATE_LIMITS.create);
  if (!gated.allowed) {
    return problem({
      type: "/problems/rate-limited",
      title: "Too Many Requests",
      status: 429,
      detail: "Share creation is rate limited. Try again later.",
    });
  }

  try {
    const created = await createOrRotateShareForOwner(id, userId);
    const response = NextResponse.json({
      data: {
        shareUrl: `${shareBaseUrl(request)}${created.sharePath}`,
        expiresAt: created.expiresAt.toISOString(),
        version: created.version,
        rotated: created.rotated,
      },
      error: null,
      meta: { traceId: crypto.randomUUID() },
    });
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    if (error instanceof ShareNotFoundError) return problem(problems.notFound("draft not found"));
    if (error instanceof ShareNotReadyError) {
      return problem({
        type: "/problems/draft-not-ready",
        title: "Draft Not Ready",
        status: 409,
        detail: error.message,
      });
    }
    if (error instanceof ShareValidationError) return problem(problems.badRequest(error.message));
    // Redacted: never include draft internals beyond the id.
    console.error("[share] create failed", { draftId: id });
    return problem(problems.internal());
  }
}

/** DELETE: owner-only immediate revocation. Idempotent. */
export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());
  const { id } = await context.params;

  const revokeGated = await checkShareRateLimit(`user:${userId}`, SHARE_RATE_LIMITS.revoke);
  if (!revokeGated.allowed) {
    return problem({
      type: "/problems/rate-limited",
      title: "Too Many Requests",
      status: 429,
      detail: "Share revocation is rate limited. Try again later.",
    });
  }

  try {
    const result = await revokeShareForOwner(id, userId);
    const response = NextResponse.json({
      data: result,
      error: null,
      meta: { traceId: crypto.randomUUID() },
    });
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    if (error instanceof ShareNotFoundError) return problem(problems.notFound("draft not found"));
    console.error("[share] revoke failed", { draftId: id });
    return problem(problems.internal());
  }
}
