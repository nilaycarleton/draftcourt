import type { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { newTraceId } from "@/lib/api/envelope";
import { ok, problem, problems, zodIssues } from "@/lib/api/draft-route-helpers";
import { writeAuditLog } from "@/lib/server/audit-log";
import {
  RateLimitedError,
  assertPreferenceMutationRate,
  auditSnapshot,
  createProfile,
  createProfileSchema,
  listProfiles,
  ProfileNameConflictError,
  PreferenceValidationError,
} from "@/lib/server/preference-profiles";

export const dynamic = "force-dynamic";

/** GET /api/v1/preference-profiles — the caller's own profiles (default
 * first), cursor-paginated. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());

  const limitParam = request.nextUrl.searchParams.get("limit");
  const cursorParam = request.nextUrl.searchParams.get("cursor");
  const limit = limitParam === null ? undefined : Number(limitParam);

  try {
    const result = await listProfiles(user.id, {
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      ...(cursorParam !== null ? { cursor: cursorParam } : {}),
    });
    const response = ok(result);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("[preferences] list failed", error);
    return problem(problems.internal());
  }
}

/** POST /api/v1/preference-profiles — create from a preset, from a full
 * settings payload, or as a blank default-strategy profile. Mutations are
 * rate-limited per user (30 / rolling minute, Postgres-backed). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  try {
    await assertPreferenceMutationRate(user.id);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return problem({
        type: "/problems/rate-limited",
        title: "Too Many Requests",
        status: 429,
        detail: "preference change rate limit reached; retry shortly",
      });
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(problems.badRequest("request body must be JSON"));
  }

  const parsed = createProfileSchema.safeParse(body);
  if (!parsed.success) {
    return problem(problems.validation(zodIssues(parsed.error)));
  }

  const traceId = newTraceId();
  try {
    const detail = await createProfile(user.id, parsed.data);
    await writeAuditLog({
      actorId: user.id,
      action: "preference.profile_created",
      entityType: "UserPreferenceProfile",
      entityId: detail.id,
      before: null,
      after: auditSnapshot(detail),
      traceId,
    });
    const response = ok(detail, { traceId });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof ProfileNameConflictError) {
      return problem(problems.conflict(error.message));
    }
    if (error instanceof PreferenceValidationError) {
      return problem(problems.validation(error.fieldErrors ?? { body: [error.message] }));
    }
    console.error("[preferences] create failed", error);
    return problem(problems.internal(), { traceId });
  }
}
