import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ok, problem, problems } from "@/lib/api/envelope";
import { CURRENT_SEASON, getCurrentRun } from "@/lib/server/current-run";
import { decodeCursor, encodeCursor, listPlayers } from "@/lib/server/players";
import { getOrRevalidate } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * Thin `overallRank`-sorted wrapper over the same player pool `GET
 * /players` serves (BUILD_SPEC.md section 8.1). This is a public/demo
 * ranking snapshot, explicitly labeled as such — never presented as a
 * real market ranking (see `data/attribution/demo-dataset.md`).
 *
 * Cached with stale-while-revalidate (ADR 0008) — the only Phase 1 route
 * this applies to, per BUILD_SPEC.md section 7.2's refresh policy: public
 * rankings can tolerate a few seconds of staleness, nothing pick-legality-
 * adjacent can (not applicable yet — no draft state exists in Phase 1).
 */

// Bump whenever the shape of the cached payload below changes, so an old
// cached entry from a prior deploy is never served through a new schema.
const RANKINGS_CACHE_SCHEMA_VERSION = 1;
const FRESH_TTL_SECONDS = 30;
const STALE_TTL_SECONDS = 300;

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rawParams = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = querySchema.safeParse(rawParams);
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "query";
      errors[key] = [...(errors[key] ?? []), issue.message];
    }
    return problem(problems.validation(errors));
  }

  const cursor = decodeCursor(parsed.data.cursor);
  // Including runId in the cache key is the invalidation mechanism: once a
  // new run publishes, every key naturally changes — no explicit purge
  // needed. A `null` run (nothing published yet) still gets its own stable
  // key rather than bypassing the cache.
  const run = await getCurrentRun();
  const cacheKey = [
    "rankings",
    `v${String(RANKINGS_CACHE_SCHEMA_VERSION)}`,
    CURRENT_SEASON,
    run?.runId ?? "none",
    `cursor:${String(cursor ?? 0)}`,
    `limit:${String(parsed.data.limit)}`,
  ].join(":");

  const { value: result, stale } = await getOrRevalidate({
    key: cacheKey,
    freshTtlSeconds: FRESH_TTL_SECONDS,
    staleTtlSeconds: STALE_TTL_SECONDS,
    compute: () =>
      listPlayers({
        filters: {},
        sort: "overallRank",
        direction: "asc",
        limit: parsed.data.limit,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
  });

  return ok(
    result.players.map((player) => ({
      rank: player.projection.overallRank,
      slug: player.slug,
      displayName: player.displayName,
      team: player.team,
      positions: player.positions,
      fantasyPoints: player.projection.fantasyPoints,
      adp: player.adp,
      adpDelta: player.adpDelta,
    })),
    {
      season: CURRENT_SEASON,
      totalCount: result.totalCount,
      nextCursor: result.nextCursor !== null ? encodeCursor(result.nextCursor) : null,
      hasMore: result.hasMore,
      projectionRunId: result.meta.runId,
      modelVersion: result.meta.modelVersion,
      demoData: true,
      stale,
    },
  );
}
