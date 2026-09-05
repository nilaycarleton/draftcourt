/**
 * Phase 3B preference-personalization benchmark (BUILD_SPEC sections 6.9/19).
 *
 * Fixture: the published demo dataset through synthetic 12-team x 16-round
 * drafts, one per strategy scenario. Each draft captures its immutable
 * preference snapshot at start exactly like production; recommendations run
 * through `getRecommendationsForOwner` so cache identity by input checksum is
 * exercised end-to-end.
 *
 * Scenarios: draftcourt-defaults (no profile), balanced preset, extreme valid
 * profile (max magnitudes/priorities/preference weight), large lists (200
 * player entries + 16 teams + 500 custom ranks).
 *
 * Run: pnpm --filter web run bench:preferences
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootEnv } from "@draftcourt/db/src/load-root-env";

// tsx runs this script directly (no Next/vitest env injection), so load the
// repo-root .env.local BEFORE any module that constructs a Prisma client.
loadRootEnv();

const { ENGINE_VERSION } = await import("@draftcourt/domain");
import type { PreferenceSettings } from "@draftcourt/domain";
const { createLeague } = await import("../lib/server/leagues");
const { createDraft, makePick, transitionStatus } = await import("../lib/server/drafts");
const { getRecommendationsForOwner } = await import("../lib/server/recommendations");
const { createProfile } = await import("../lib/server/preference-profiles");
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

const ROSTER: {
  position: "PG" | "SG" | "G" | "SF" | "PF" | "F" | "C" | "UTIL" | "BENCH";
  count: number;
  starter: boolean;
}[] = [
  { position: "PG", count: 1, starter: true },
  { position: "SG", count: 1, starter: true },
  { position: "G", count: 1, starter: true },
  { position: "SF", count: 1, starter: true },
  { position: "PF", count: 1, starter: true },
  { position: "F", count: 1, starter: true },
  { position: "C", count: 1, starter: true },
  { position: "UTIL", count: 3, starter: true },
  { position: "BENCH", count: 4, starter: false },
];

const SAMPLES_PER_STATE = 7;
const DEPTH_PICKS = 12;

async function main(): Promise<void> {
  const user = await prisma.user.create({
    data: { clerkUserId: ["bench-pref", String(Date.now())].join("-") },
    select: { id: true },
  });

  const suffix = crypto.randomUUID();
  const scenarios: {
    name: string;
    profileId: string | null;
    description: string;
  }[] = [
    {
      name: "draftcourt-defaults",
      profileId: null,
      description: "No profile selected — versioned DraftCourt defaults snapshot",
    },
  ];

  try {
    // Balanced preset profile.
    const balanced = await createProfile(user.id, {
      name: `Balanced ${suffix.slice(0, 6)}`,
      preset: { key: "balanced" },
      isDefault: false,
    });
    scenarios.push({
      name: "balanced-preset",
      profileId: balanced.id,
      description: "Balanced preset applied verbatim",
    });

    // Extreme-but-valid profile: preference weight maxed, scalars at bounds,
    // every position prioritized, explicit punts, avoid mode severe.
    const extremeSettings: PreferenceSettings = {
      schemaVersion: 1,
      factorWeights: {
        production: 0,
        scarcity: 0,
        rosterNeed: 0,
        risk: 0,
        consistency: 0,
        age: 0,
        adpValue: 0,
        upside: 0,
        role: 0,
        nextPickAvailability: 0,
        preference: 1,
      },
      lockedFactors: [],
      riskTolerance: 0,
      upsidePriority: 1,
      youthBias: 1,
      roleMinutesPriority: 1,
      schedule: { enabled: false, playoffWeeks: null },
      positionPriorities: [
        { position: "PG", priority: 1 },
        { position: "SG", priority: 1 },
        { position: "SF", priority: 1 },
        { position: "PF", priority: 1 },
        { position: "C", priority: 1 },
      ],
      categoryPriorities: [
        { stat: "PTS", weight: 1 },
        { stat: "THREE_PM", weight: 1 },
        { stat: "TOV", weight: 0 },
      ],
      puntStats: ["TOV"],
      avoidMode: "SEVERE_PENALTY",
    };
    const topPlayers = await prisma.playerProjection.findMany({
      where: { run: { season: "2026-27", isCurrent: true } },
      orderBy: { overallRank: "asc" },
      take: 200,
      select: { playerId: true },
    });
    const extremeLists = {
      playerPreferences: [
        ...topPlayers.slice(0, 50).map((p) => ({
          playerId: p.playerId,
          listType: "TARGET" as const,
          magnitude: 1,
        })),
        ...topPlayers.slice(50, 100).map((p) => ({
          playerId: p.playerId,
          listType: "AVOID" as const,
          magnitude: -1,
        })),
      ],
      teamPreferences: [] as { teamId: string; listType: "FAVORITE"; magnitude: number }[],
    };
    const teams = await prisma.nbaTeam.findMany({ take: 8, select: { id: true } });
    for (const team of teams) {
      extremeLists.teamPreferences.push({ teamId: team.id, listType: "FAVORITE", magnitude: 1 });
    }
    const extreme = await createProfile(user.id, {
      name: `Extreme ${suffix.slice(0, 6)}`,
      settings: extremeSettings,
      ...extremeLists,
      isDefault: false,
    });
    scenarios.push({
      name: "extreme-valid",
      profileId: extreme.id,
      description:
        "preference weight=1, scalars at bounds, all positions prioritized, 50 targets + 50 avoids + 8 favorite teams",
    });

    // Large lists: dense custom ranks over the projected board plus big lists.
    const rankEntries = topPlayers.map((p, index) => ({ playerId: p.playerId, rank: index + 1 }));
    const largeSettings: PreferenceSettings = {
      ...extremeSettings,
      factorWeights: {
        production: 0.3,
        scarcity: 0.1,
        rosterNeed: 0.15,
        risk: 0.05,
        consistency: 0.05,
        age: 0.05,
        adpValue: 0.1,
        upside: 0.1,
        role: 0.05,
        nextPickAvailability: 0.03,
        preference: 0.02,
      },
      avoidMode: "EXCLUDE",
      categoryPriorities: [],
      puntStats: [],
    };
    const large = await prisma.preferenceProfile.create({
      data: {
        ownerId: user.id,
        name: `Large ${suffix.slice(0, 6)}`,
        presetKey: null,
        presetVersion: null,
        settingsJson: largeSettings,
        isDefault: false,
        playerPreferences: {
          // Same per-list cap (50) the production API enforces.
          create: [
            ...topPlayers.slice(0, 50).map((p) => ({
              playerId: p.playerId,
              listType: "FAVORITE" as const,
              magnitude: 0.5,
            })),
            ...topPlayers.slice(50, 100).map((p) => ({
              playerId: p.playerId,
              listType: "DISLIKED" as const,
              magnitude: -0.5,
            })),
            ...topPlayers.slice(100, 150).map((p) => ({
              playerId: p.playerId,
              listType: "AVOID" as const,
              magnitude: -1,
            })),
          ],
        },
        teamPreferences: {
          create: teams.map((team) => ({
            teamId: team.id,
            listType: "DISLIKED" as const,
            magnitude: -0.8,
          })),
        },
      },
      select: { id: true },
    });
    await prisma.customPlayerRank.createMany({
      data: rankEntries.map((entry) => ({
        ownerId: user.id,
        leagueId: null,
        playerId: entry.playerId,
        rank: entry.rank,
      })),
    });
    scenarios.push({
      name: "large-lists",
      profileId: large.id,
      description:
        "150 player entries (50 favorite/50 disliked/50 avoid) + 8 disliked teams + 230 global custom ranks, EXCLUDE avoids",
    });

    const board = await prisma.playerProjection.findMany({
      where: { run: { season: "2026-27", isCurrent: true } },
      orderBy: { overallRank: "asc" },
      select: { playerId: true },
    });
    if (board.length < 200)
      throw new Error("demo projection run missing or too small — seed first");
    const currentRun = await prisma.projectionRun.findFirst({
      where: { season: "2026-27", isCurrent: true },
      select: {
        id: true,
        inputChecksum: true,
        model: { select: { modelKey: true, version: true } },
      },
    });
    if (!currentRun) throw new Error("no current projection run");

    const results: Record<string, unknown>[] = [];
    for (const scenario of scenarios) {
      const league = await createLeague(user.id, {
        name: `Pref Bench ${scenario.name}`.slice(0, 80),
        season: "2026-27",
        teamCount: 12,
        userDraftSlot: 6,
        rounds: 16,
        config: {
          type: "CATEGORIES",
          horizon: "REDRAFT",
          playoffWeeks: null,
          scoringRules: RULES,
          rosterSlots: ROSTER,
        },
      });
      if (scenario.profileId !== null) {
        await prisma.league.update({
          where: { id: league.id },
          data: { preferredProfileId: scenario.profileId },
        });
      }
      const draft = await createDraft(user.id, { leagueId: league.id });
      await transitionStatus({ draftId: draft.id, ownerId: user.id, action: "start" });

      const stored = await prisma.draft.findUniqueOrThrow({
        where: { id: draft.id },
        select: { preferenceSnapshotChecksum: true },
      });

      let picksMade = 0;
      let version = 1;
      for (let cursor = 0; cursor < board.length && picksMade < DEPTH_PICKS; cursor++) {
        const candidate = board[cursor];
        if (candidate === undefined) break;
        try {
          await makePick({
            draftId: draft.id,
            ownerId: user.id,
            playerId: candidate.playerId,
            idempotencyKey: [`pref-bench`, scenario.name, String(picksMade)].join("-"),
            ifMatchVersion: version,
          });
          picksMade += 1;
          version += 1;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "";
          if (message.includes("no legal roster slot") || message.includes("already drafted")) {
            continue;
          }
          throw error;
        }
      }

      const coldTimes: number[] = [];
      const warmTimes: number[] = [];
      for (let sample = 0; sample < SAMPLES_PER_STATE; sample++) {
        const coldStart = Date.now();
        const cold = await getRecommendationsForOwner(draft.id, user.id, { force: true });
        coldTimes.push(Date.now() - coldStart);
        void cold;

        const warmStart = Date.now();
        await getRecommendationsForOwner(draft.id, user.id);
        warmTimes.push(Date.now() - warmStart);
      }

      results.push({
        scenario: scenario.name,
        description: scenario.description,
        snapshotChecksum: stored.preferenceSnapshotChecksum,
        poolSize: board.length - picksMade,
        depthPicks: picksMade,
        cold: percentiles(coldTimes),
        warm: percentiles(warmTimes),
      });

      await prisma.draft.deleteMany({ where: { id: draft.id } }).catch(() => undefined);
      await prisma.league.deleteMany({ where: { id: league.id } }).catch(() => undefined);
    }

    const result = {
      date: new Date().toISOString(),
      fixture: {
        projectionRunId: currentRun.id,
        modelVersion: `${currentRun.model.modelKey}@${currentRun.model.version}`,
        runInputChecksum: currentRun.inputChecksum,
        poolSize: board.length,
      },
      engineVersion: ENGINE_VERSION,
      seedPolicy:
        "simulation seeds derive deterministically from draftId + projectionRunId per recommendation call",
      samplesPerState: SAMPLES_PER_STATE,
      depthPicks: DEPTH_PICKS,
      environment: `local docker postgres; node ${process.version}; ${process.platform}`,
      scenarios: results,
      targets: { coldP95UnderMs: 800, warmP95UnderMs: 300 },
    };

    mkdirSync("../../docs/benchmarks", { recursive: true });
    writeFileSync(
      join("../../docs/benchmarks/preferences-latest.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.info(JSON.stringify(result, null, 2)); // eslint-disable-line no-console -- benchmark output is the deliverable
  } finally {
    await prisma.customPlayerRank
      .deleteMany({ where: { ownerId: user.id } })
      .catch(() => undefined);
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
