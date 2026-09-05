import type { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { newTraceId } from "@/lib/api/envelope";
import { ok, problem, problems, zodIssues } from "@/lib/api/draft-route-helpers";
import { writeAuditLog } from "@/lib/server/audit-log";
import {
  RankConflictError,
  RankScopeNotFoundError,
  RankValidationError,
  listRanks,
  replaceRanks,
  replaceRanksSchema,
} from "@/lib/server/custom-ranks";
import { RateLimitedError, assertPreferenceMutationRate } from "@/lib/server/preference-profiles";

export const dynamic = "force-dynamic";

/** GET /api/v1/custom-ranks?leagueId=… — the caller's ranks for one scope
 * (global board when leagueId is absent), ordered by rank ascending. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());

  const leagueParam = request.nextUrl.searchParams.get("leagueId");
  if (leagueParam !== null && !/^[0-9a-f-]{36}$/i.test(leagueParam)) {
    return problem(problems.badRequest("leagueId must be a UUID"));
  }

  try {
    const ranks = await listRanks(user.id, { leagueId: leagueParam });
    const response = ok({ leagueId: leagueParam, ranks });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("[custom-ranks] list failed", error);
    return problem(problems.internal());
  }
}

/** PUT /api/v1/custom-ranks — transactional full-scope replacement. The
 * payload must be a duplicate-free permutation of dense ranks 1..N over
 * known, non-retired players; any violation rolls back atomically. */
export async function PUT(request: NextRequest): Promise<NextResponse> {
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
  const parsed = replaceRanksSchema.safeParse(body);
  if (!parsed.success) {
    return problem(problems.validation(zodIssues(parsed.error)));
  }

  const traceId = newTraceId();
  try {
    const result = await replaceRanks(user.id, parsed.data);
    await writeAuditLog({
      actorId: user.id,
      action: "preference.custom_ranks_replaced",
      entityType: "CustomPlayerRank",
      entityId: parsed.data.leagueId ?? "global",
      before: null,
      after: { scope: parsed.data.leagueId === null ? "global" : "league", count: result.count },
      traceId,
    });
    const response = ok(result, { traceId });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof RankScopeNotFoundError) {
      return problem(problems.notFound("league not found"));
    }
    if (error instanceof RankValidationError) {
      return problem(problems.validation(error.fieldErrors ?? { ranks: [error.message] }));
    }
    if (error instanceof RankConflictError) {
      return problem(problems.conflict(error.message));
    }
    console.error("[custom-ranks] replace failed", error);
    return problem(problems.internal(), { traceId });
  }
}
