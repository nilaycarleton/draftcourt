/**
 * Recommendation latency benchmark (BUILD_SPEC.md sections 6.9 and 19).
 *
 * Fixture: the published demo dataset driven through a synthetic 12-team x
 * 16-round draft at several board depths. Measures COLD (recompute at that
 * sequence) vs WARM (cached snapshot) server-path latency through
 * `getRecommendationsForOwner`.
 *
 * Run: pnpm --filter web run bench:recommendations
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootEnv } from "@draftcourt/db/src/load-root-env";

// tsx runs this script directly (no Next/vitest env injection), so load the
// repo-root .env.local BEFORE any module that constructs a Prisma client.
loadRootEnv();

const { ENGINE_VERSION } = await import("@draftcourt/domain");
const { createLeague } = await import("../lib/server/leagues");
const { createDraft, makePick, transitionStatus } = await import("../lib/server/drafts");
const { getRecommendationsForOwner } = await import("../lib/server/recommendations");
const { prisma } = await import("@draftcourt/db");

interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  n: number;
}

function percentiles(valuesMs: number[]): Percentiles {
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), n: sorted.length };
}

const RULES = ["PTS", "REB", "AST", "TOV", "FG_PCT", "FT_PCT", "STL", "BLK", "THREE_PM"].map(
  (stat) => ({
    stat,
    weight: 1,
    direction: stat === "TOV" ? ("LOWER_BETTER" as const) : ("HIGHER_BETTER" as const),
    enabled: true,
    punt: false,
  }),
);

async function main(): Promise<void> {
  const user = await prisma.user.create({
    data: { clerkUserId: ["bench", String(Date.now())].join("-") },
    select: { id: true },
  });

  try {
    const league = await createLeague(user.id, {
      name: "Bench League",
      season: "2026-27",
      teamCount: 12,
      userDraftSlot: 6,
      rounds: 16,
      config: {
        type: "CATEGORIES",
        horizon: "REDRAFT",
        playoffWeeks: null,
        scoringRules: RULES,
        rosterSlots: [
          { position: "PG", count: 1, starter: true },
          { position: "SG", count: 1, starter: true },
          { position: "G", count: 1, starter: true },
          { position: "SF", count: 1, starter: true },
          { position: "PF", count: 1, starter: true },
          { position: "F", count: 1, starter: true },
          { position: "C", count: 1, starter: true },
          { position: "UTIL", count: 3, starter: true },
          { position: "BENCH", count: 4, starter: false },
        ],
      },
    });
    const draft = await createDraft(user.id, { leagueId: league.id });
    await transitionStatus({ draftId: draft.id, ownerId: user.id, action: "start" });

    const board = await prisma.playerProjection.findMany({
      where: { run: { season: "2026-27", isCurrent: true } },
      orderBy: { overallRank: "asc" },
      select: { playerId: true },
    });

    // Drive to three board depths, measuring cold + warm at each.
    const coldTimes: number[] = [];
    const warmTimes: number[] = [];
    let version = 1;
    let picksMade = 0;

    let boardCursor = 0;
    const skip = 0;
    for (const targetDepth of [12, 60, 120]) {
      while (picksMade < targetDepth) {
        const playerId = board[boardCursor]?.playerId;
        if (!playerId) throw new Error("board exhausted");
        boardCursor += 1;
        try {
          await makePick({
            draftId: draft.id,
            ownerId: user.id,
            playerId,
            idempotencyKey: ["bench-pick", String(picksMade), String(skip)].join("-"),
            ifMatchVersion: version,
          });
          picksMade += 1;
          version += 1;
        } catch (error: unknown) {
          // Real boards skip players with no open legal slot at this point.
          const message = error instanceof Error ? error.message : "";
          if (message.includes("no legal roster slot")) continue;
          throw error;
        }
      }

      for (let sample = 0; sample < 7; sample++) {
        const coldStart = Date.now();
        await getRecommendationsForOwner(draft.id, user.id, { force: true });
        coldTimes.push(Date.now() - coldStart);

        const warmStart = Date.now();
        await getRecommendationsForOwner(draft.id, user.id);
        warmTimes.push(Date.now() - warmStart);
      }
    }

    const result = {
      date: new Date().toISOString(),
      fixture:
        "demo dataset, 12 teams x 16 rounds, categories (9-cat), measured at picks 12/60/120",
      engineVersion: ENGINE_VERSION,
      strategyScenario: "draftcourt-defaults (no profile selected)",
      poolSize: picksMade > 0 ? board.length - picksMade : board.length,
      cold: percentiles(coldTimes),
      warm: percentiles(warmTimes),
      targets: { coldP95UnderMs: 800, warmP95UnderMs: 300 },
    };

    mkdirSync("../../docs/benchmarks", { recursive: true });
    writeFileSync(
      join("../../docs/benchmarks/recommendations-latest.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.info(JSON.stringify(result, null, 2)); // eslint-disable-line no-console -- benchmark output is the deliverable

    await prisma.draft.deleteMany({ where: { id: draft.id } }).catch(() => undefined);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
