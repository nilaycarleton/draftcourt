import { prisma } from "@draftcourt/db";
import { inngest } from "@/lib/inngest/client";
import { CURRENT_SEASON } from "@/lib/server/current-run";

/**
 * The one Inngest function Phase 1 actually ships. It only ever *reads*
 * Postgres and logs a structured warning when the current run is stale —
 * it deliberately does NOT trigger ingestion or a new projection run.
 *
 * Why: BUILD_SPEC's original sketch also called for scheduled-refresh and
 * projection-generation background functions, but those require an HTTP
 * entry point into the Python analytics service that was never built
 * (only its Typer CLI exists — see docs/adr/0008-background-jobs-and-caching.md
 * and docs/adr/0009-admin-authorization.md for the same gap found on the
 * admin side). Wiring a fake trigger here — one that logs success without
 * actually running anything — would violate the "nothing faked" rule, so
 * it's left undone and documented rather than stubbed.
 */
const STALE_THRESHOLD_HOURS = 24;

export interface FreshnessCheckResult {
  stale: boolean;
  reason?: string;
  runId?: string;
  ageHours?: number;
}

export async function checkProjectionFreshness(): Promise<FreshnessCheckResult> {
  const run = await prisma.projectionRun.findFirst({
    where: { season: CURRENT_SEASON, isCurrent: true },
    orderBy: { publishedAt: "desc" },
  });

  if (!run?.publishedAt) {
    return { stale: true, reason: "no published projection run for the current season" };
  }

  const ageHours = (Date.now() - run.publishedAt.getTime()) / (1000 * 60 * 60);
  return { stale: ageHours > STALE_THRESHOLD_HOURS, runId: run.id, ageHours };
}

export const freshnessCheckFunction = inngest.createFunction(
  { id: "projection-freshness-check", triggers: [{ cron: "0 * * * *" }] },
  async () => {
    const result = await checkProjectionFreshness();
    if (result.stale) {
      // No paging/email integration exists yet — a structured console
      // warning is the honest current behavior, findable in logs/Sentry
      // breadcrumbs rather than a fabricated "alert sent" claim.
      console.warn("[freshness-check] stale projection data", result);
    }
    return result;
  },
);
