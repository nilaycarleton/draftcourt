import type { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { newTraceId } from "@/lib/api/envelope";
import { ok, problem, problems, zodIssues, type RouteContext } from "@/lib/api/draft-route-helpers";
import { writeAuditLog } from "@/lib/server/audit-log";
import {
  RateLimitedError,
  assertPreferenceMutationRate,
  auditSnapshot,
  deleteProfile,
  getProfile,
  ProfileNameConflictError,
  PreferenceNotFoundError,
  PreferenceValidationError,
  updateProfile,
  updateProfileSchema,
} from "@/lib/server/preference-profiles";

export const dynamic = "force-dynamic";

/** GET /api/v1/preference-profiles/:id — owner-only detail; non-owned ids
 * resolve to the same 404 as missing ids (no enumeration oracle). */
export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    const detail = await getProfile(user.id, id);
    if (!detail) return problem(problems.notFound("preference profile not found"));
    const response = ok(detail);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("[preferences] get failed", error);
    return problem(problems.internal());
  }
}

/** PATCH /api/v1/preference-profiles/:id — rename, replace settings (or
 * re-apply a preset), set default, and/or replace preference lists. */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  const { id } = await context.params;

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
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return problem(problems.validation(zodIssues(parsed.error)));
  }

  const traceId = newTraceId();
  try {
    const before = await getProfile(user.id, id);
    if (!before) return problem(problems.notFound("preference profile not found"));
    const after = await updateProfile(user.id, id, parsed.data);
    await writeAuditLog({
      actorId: user.id,
      action: "preference.profile_updated",
      entityType: "UserPreferenceProfile",
      entityId: id,
      before: auditSnapshot(before),
      after: auditSnapshot(after),
      traceId,
    });
    const response = ok(after, { traceId });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof PreferenceNotFoundError) {
      return problem(problems.notFound("preference profile not found"));
    }
    if (error instanceof ProfileNameConflictError) {
      return problem(problems.conflict(error.message));
    }
    if (error instanceof PreferenceValidationError) {
      return problem(problems.validation(error.fieldErrors ?? { body: [error.message] }));
    }
    console.error("[preferences] update failed", error);
    return problem(problems.internal(), { traceId });
  }
}

/** DELETE /api/v1/preference-profiles/:id — safe delete with automatic
 * default promotion when profiles remain. */
export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  const { id } = await context.params;

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

  const traceId = newTraceId();
  try {
    const before = await getProfile(user.id, id);
    if (!before) return problem(problems.notFound("preference profile not found"));
    const result = await deleteProfile(user.id, id);
    await writeAuditLog({
      actorId: user.id,
      action: "preference.profile_deleted",
      entityType: "UserPreferenceProfile",
      entityId: id,
      before: auditSnapshot(before),
      after: result.promotedDefaultName
        ? { promotedDefaultName: result.promotedDefaultName }
        : null,
      traceId,
    });
    const response = ok(result, { traceId });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof PreferenceNotFoundError) {
      return problem(problems.notFound("preference profile not found"));
    }
    console.error("[preferences] delete failed", error);
    return problem(problems.internal(), { traceId });
  }
}
