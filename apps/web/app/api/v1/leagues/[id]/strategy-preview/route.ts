import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/server/auth";
import { zodIssuesToFieldErrors } from "@/lib/server/players-query";
import { ok, problem, problems } from "@/lib/api/envelope";
import { getLeagueDetail } from "@/lib/server/leagues";
import { previewResolvedStrategy } from "@/lib/server/preference-snapshot";

export const dynamic = "force-dynamic";

/**
 * Resolved-strategy preview for a league (Phase 3B): shows what WOULD be
 * captured at draft start under the current precedence chain without
 * persisting anything. An optional owned `overrideProfileId` query parameter
 * previews the same resolution with a pre-start draft override applied.
 */

const previewQuerySchema = z.object({
  overrideProfileId: z.uuid().optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  const { id } = await context.params;

  const url = new URL(request.url);
  const overrideRaw = url.searchParams.get("overrideProfileId") ?? undefined;
  const parsedQuery = previewQuerySchema.safeParse(
    overrideRaw === undefined ? {} : { overrideProfileId: overrideRaw },
  );
  if (!parsedQuery.success) {
    return problem(problems.validation(zodIssuesToFieldErrors(parsedQuery.error.issues)));
  }

  try {
    // Ownership + existence first (same 404 for missing and not-owned).
    const detail = await getLeagueDetail(user.id, id);
    if (!detail) return problem(problems.notFound("league not found"));

    const preview = await previewResolvedStrategy(user.id, {
      leaguePreferredProfileId: detail.strategySelection.preferredProfileId,
      overrideProfileId: parsedQuery.data.overrideProfileId ?? null,
      leagueId: detail.id,
    });
    return ok(preview);
  } catch (error) {
    console.error("[leagues] strategy preview failed", error);
    return problem(problems.internal());
  }
}
