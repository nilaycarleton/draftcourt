/**
 * Phase 3C CPU/mock benchmark (BUILD_SPEC sections 6.9/11/19).
 *
 * Measures:
 * - pure domain selection latency per personality (8 scenarios, no I/O)
 * - one authoritative CPU pick transaction through makeCpuPickForOwner
 * - complete seeded mock drafts: 12-team points, 12-team categories,
 *   12-team dynasty
 *
 * Presentation speeds are client pacing only and never enter server math;
 * they are intentionally NOT benchmarked here (fake-time unit tests cover
 * pacing determinism).
 *
 * Run: pnpm --filter web run bench:cpu-mock
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootEnv } from "@draftcourt/db/src/load-root-env";

loadRootEnv();

const {
  ENGINE_VERSION,
  PREFERENCE_SNAPSHOT_VERSION,
  CPU_PERSONALITY_VERSION,
  CPU_SEED_STRATEGY_VERSION,
  cpuPersonalities,
  selectCpuPick,
  toCpuPersonalitySnapshot,
  overallPickToSlot,
} = await import("@draftcourt/domain");
import type { CpuDecisionInput } from "@draftcourt/domain";
const { createLeague } = await import("../lib/server/leagues");
const { createDraft, transitionStatus } = await import("../lib/server/drafts");
const { makeCpuPickForOwner } = await import("../lib/server/cpu-mock");
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

function scoringRules(type: "POINTS" | "CATEGORIES") {
  const stats =
    type === "POINTS"
      ? ["PTS", "REB", "AST", "TOV"]
      : ["PTS", "REB", "AST", "TOV", "FG_PCT", "FT_PCT", "STL", "BLK", "THREE_PM"];
  return stats.map((stat) => ({
    stat,
    weight: 1,
    direction: stat === "TOV" ? ("LOWER_BETTER" as const) : ("HIGHER_BETTER" as const),
    enabled: true,
    punt: false,
  }));
}

const ROSTER: {
  position: "PG" | "SG" | "SF" | "PF" | "C" | "G" | "F" | "UTIL" | "BENCH";
  count: number;
  starter: boolean;
}[] = [
  { position: "PG", count: 2, starter: true },
  { position: "SG", count: 2, starter: true },
  { position: "SF", count: 2, starter: true },
  { position: "PF", count: 1, starter: true },
  { position: "C", count: 1, starter: true },
  { position: "UTIL", count: 2, starter: true },
  { position: "BENCH", count: 4, starter: false },
];

async function main(): Promise<void> {
  const user = await prisma.user.create({
    data: { clerkUserId: ["bench-cpu", String(Date.now())].join("-") },
    select: { id: true },
  });

  try {
    const run = await prisma.projectionRun.findFirst({
      where: { season: "2026-27", isCurrent: true },
      select: {
        id: true,
        inputChecksum: true,
        model: { select: { modelKey: true, version: true } },
        projections: { orderBy: { overallRank: "asc" }, take: 400, select: { playerId: true } },
      },
    });
    if (!run) throw new Error("demo projection run missing — seed first");
    const projectedIds = new Set(run.projections.map((p) => p.playerId));
    const [projections, players] = await Promise.all([
      prisma.playerProjection.findMany({
        where: { runId: run.id },
        select: {
          playerId: true,
          games: true,
          minutesPerGame: true,
          pts: true,
          reb: true,
          ast: true,
          stl: true,
          blk: true,
          tov: true,
          fgm: true,
          fga: true,
          ftm: true,
          fta: true,
          threePm: true,
          lower80: true,
          upper80: true,
          injuryRisk: true,
          consistency: true,
          upside: true,
          roleSecurity: true,
        },
      }),
      prisma.player.findMany({
        select: {
          id: true,
          displayName: true,
          status: true,
          dob: true,
          currentTeamId: true,
          eligibilities: { select: { position: true } },
        },
      }),
    ]);
    void players;

    // ---- Pure selection benchmark per personality ------------------------
    const engineProjections = projections.map((line) => ({
      playerId: line.playerId,
      games: line.games,
      minutesPerGame: line.minutesPerGame,
      pts: line.pts,
      reb: line.reb,
      ast: line.ast,
      stl: line.stl,
      blk: line.blk,
      tov: line.tov,
      fgm: line.fgm,
      fga: line.fga,
      ftm: line.ftm,
      fta: line.fta,
      threePm: line.threePm,
      lower80: (line.lower80 ?? {}) as Record<string, number>,
      upper80: (line.upper80 ?? {}) as Record<string, number>,
      injuryRisk: line.injuryRisk,
      consistency: line.consistency,
      upside: line.upside,
      roleSecurity: line.roleSecurity,
    }));
    const metaPlayers = await prisma.player.findMany({
      where: { id: { in: [...projectedIds] } },
      select: {
        id: true,
        displayName: true,
        status: true,
        dob: true,
        currentTeamId: true,
        eligibilities: { select: { position: true } },
      },
    });
    const year = new Date().getFullYear();
    const enginePlayers = metaPlayers.map((p) => ({
      playerId: p.id,
      displayName: p.displayName,
      eligiblePositions: p.eligibilities.map((e) => e.position),
      status: p.status,
      nbaTeamId: p.currentTeamId ?? undefined,
      ...(p.dob && year - p.dob.getFullYear() > 0 && year - p.dob.getFullYear() < 60
        ? { age: year - p.dob.getFullYear() }
        : {}),
    }));
    void enginePlayers;

    // EngineSettings shape (isStarter) for the PURE selector; the league
    // config shape (starter) is used only by createLeague below.
    const settingsFixture = {
      season: "2026-27",
      type: "CATEGORIES" as const,
      horizon: "REDRAFT" as const,
      teamCount: 12,
      rounds: 14,
      userDraftSlot: 1,
      scoringRules: scoringRules("CATEGORIES"),
      rosterSlots: ROSTER.map((slot) => ({
        position: slot.position,
        count: slot.count,
        isStarter: slot.starter,
      })),
    };
    const personalitySelections: Record<string, Percentiles> = {};
    for (const personality of cpuPersonalities) {
      const input: CpuDecisionInput = {
        settings: settingsFixture,
        projectionRunId: run.id,
        modelVersion: `${run.model.modelKey}@${run.model.version}`,
        projections: engineProjections,
        players: enginePlayers.filter((p) =>
          engineProjections.some((line) => line.playerId === p.playerId),
        ),
        adp: null,
        assignments: [],
        // Pick 14 of a 12-team snake lands on slot 11 (round 2, reversed).
        currentTeamSlot: 11,
        nextOverallPick: 14,
        personality: toCpuPersonalitySnapshot(personality),
        draftSeed: 123456789,
        includeUnsigned: false,
      };
      const samples: number[] = [];
      for (let i = 0; i < 21; i++) {
        const start = performance.now();
        const decision = selectCpuPick(input);
        samples.push(performance.now() - start);
        if (!decision.ok) throw new Error(`selection failed for ${personality.key}`);
      }
      personalitySelections[personality.key] = percentiles(samples);
    }

    // ---- Full transactional mock benchmarks ------------------------------
    async function runFullMock(options: {
      name: string;
      type: "POINTS" | "CATEGORIES";
      horizon: "REDRAFT" | "DYNASTY";
      teamCount: number;
      rounds: number;
      seed: string;
    }): Promise<{ cold: Percentiles; warm: Percentiles; picks: number }> {
      const league = await createLeague(user.id, {
        name: `CPU Bench ${options.name}`.slice(0, 80),
        season: "2026-27",
        teamCount: options.teamCount,
        userDraftSlot: 1,
        rounds: options.rounds,
        config: {
          type: options.type,
          horizon: options.horizon,
          playoffWeeks: null,
          scoringRules: scoringRules(options.type),
          rosterSlots: ROSTER,
        },
      });
      const draft = await createDraft(user.id, {
        leagueId: league.id,
        type: "MOCK",
        simulationSeed: options.seed,
        cpuPersonalityKey: "balanced",
      });
      await transitionStatus({ draftId: draft.id, ownerId: user.id, action: "start" });

      const firstCold: number[] = [];
      const warm: number[] = [];
      let picks = 0;
      const total = options.teamCount * options.rounds;
      let guard = 0;
      while (picks < total && guard < total * 3) {
        guard += 1;
        const draftRow = await prisma.draft.findUniqueOrThrow({
          where: { id: draft.id },
          select: { nextOverallPick: true, version: true, status: true },
        });
        if (draftRow.status !== "ACTIVE") break;
        const slot = overallPickToSlot(draftRow.nextOverallPick, options.teamCount);
        if (slot === 1) {
          // User slot: drive via recommendations top-3 to keep the board legal.
          const recs = await getRecommendationsForOwner(draft.id, user.id);
          const target = recs?.output.top3[0];
          if (!target) break;
          const { makePick } = await import("../lib/server/drafts");
          await makePick({
            draftId: draft.id,
            ownerId: user.id,
            playerId: target.playerId,
            idempotencyKey: [`cpu-bench-user`, draft.id, String(picks)].join("-"),
            ifMatchVersion: draftRow.version,
          });
          picks += 1;
        } else {
          const isCold = warm.length === 0 && firstCold.length < 3;
          const draftRow = await prisma.draft.findUniqueOrThrow({
            where: { id: draft.id },
            select: { version: true },
          });
          const start = performance.now();
          await makeCpuPickForOwner(
            draft.id,
            user.id,
            ["cpu-bench", draft.id, String(guard)].join("-"),
            draftRow.version,
          );
          const ms = performance.now() - start;
          if (isCold && firstCold.length < 3) firstCold.push(ms);
          else warm.push(ms);
          picks += 1;
        }
      }

      await prisma.draft.deleteMany({ where: { id: draft.id } }).catch(() => undefined);
      await prisma.league.deleteMany({ where: { id: league.id } }).catch(() => undefined);
      return {
        cold: percentiles(firstCold),
        warm: percentiles(warm),
        picks,
      };
    }

    const fullMocks = {
      twelveTeamPoints: await runFullMock({
        name: "12P",
        type: "POINTS",
        horizon: "REDRAFT",
        teamCount: 12,
        rounds: 14,
        seed: "bench-points-seed",
      }),
      twelveTeamCategories: await runFullMock({
        name: "12C",
        type: "CATEGORIES",
        horizon: "REDRAFT",
        teamCount: 12,
        rounds: 14,
        seed: "bench-categories-seed",
      }),
      twelveTeamDynasty: await runFullMock({
        name: "12D",
        type: "CATEGORIES",
        horizon: "DYNASTY",
        teamCount: 12,
        rounds: 14,
        seed: "bench-dynasty-seed",
      }),
    };

    const result = {
      date: new Date().toISOString(),
      fixture: {
        projectionRunId: run.id,
        modelVersion: `${run.model.modelKey}@${run.model.version}`,
        runInputChecksum: run.inputChecksum,
        poolSize: projections.length,
      },
      versions: {
        engineVersion: ENGINE_VERSION,
        preferenceSnapshotVersion: PREFERENCE_SNAPSHOT_VERSION,
        cpuPersonalityVersion: CPU_PERSONALITY_VERSION,
        cpuSeedStrategyVersion: CPU_SEED_STRATEGY_VERSION,
      },
      seedPolicy:
        "per-pick decision seeds derive from simulationSeed string + personality key/version + teamSlot + nextOverallPick (seedStrategyVersion 1)",
      samplesPerScenario: 21,
      pureSelectionByPersonalityMs: personalitySelections,
      fullMocks,
      environment: `local docker postgres; node ${process.version}; ${process.platform}`,
    };

    mkdirSync("../../docs/benchmarks", { recursive: true });
    writeFileSync(
      join("../../docs/benchmarks/cpu-mock-latest.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.info(JSON.stringify(result, null, 2)); // eslint-disable-line no-console -- benchmark output is the deliverable
  } finally {
    await prisma.preferenceProfile
      .deleteMany({ where: { ownerId: user.id } })
      .catch(() => undefined);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
