/**
 * Consolidated Phase 3 acceptance benchmark matrix (BUILD_SPEC.md §19, M9).
 *
 * Server path (real demo dataset, local Postgres): for 8/10/12/14/16-team
 * MOCK drafts — cold/warm recommendation latency at mid-board, pick-mutation
 * latency, full seeded mock completion, full event replay, analysis
 * generation, history retrieval, share create/lookup/revoke.
 *
 * Pure-engine path (deterministic synthetic 600-player pool, no DB): cold
 * recommend(), selectCpuPick(), analyzeDraft(), replayFull().
 *
 * Optional ingestion stage: `--with-ingest` re-runs scripts/demo-ingest.sh
 * timed (safe: ingestion dedupes by checksum; publish appends a run).
 *
 * Output: docs/benchmarks/team-matrix-latest.json (machine/commit/dataset
 * checksums/p50/p95/p99 recorded — no production-capacity claims).
 *
 * Run: pnpm --filter web run bench:team-matrix [-- --with-ingest]
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join } from "node:path";
import type {
  Analysis,
  EngineAdpEntry,
  EnginePlayerMeta,
  EngineProjection,
  EngineSettings,
} from "@draftcourt/domain";
import { loadRootEnv } from "@draftcourt/db/src/load-root-env";

// tsx runs this script directly (no Next/vitest env injection), so load the
// repo-root .env.local BEFORE any module that constructs a Prisma client.
loadRootEnv();

const REPO_ROOT = join(process.cwd(), "..", "..");

const domain = await import("@draftcourt/domain");
const { createLeague } = await import("../lib/server/leagues");
const { createDraft, makePick, transitionStatus, listEventsForOwner, verifyReplayIntegrity } =
  await import("../lib/server/drafts");
const { makeCpuPickForOwner } = await import("../lib/server/cpu-mock");
const { getRecommendationsForOwner } = await import("../lib/server/recommendations");
const { getOrGenerateAnalysisForOwner } = await import("../lib/server/analysis");
const { listHistoryForOwner } = await import("../lib/server/history");
const { createOrRotateShareForOwner, lookupSharedResult, revokeShareForOwner } =
  await import("../lib/server/share");
const { prisma } = await import("@draftcourt/db");

const {
  ENGINE_VERSION,
  recommend,
  selectCpuPick,
  analyzeDraft,
  replayFull,
  mulberry32,
  overallPickToSlot,
  cpuPersonalityByKey,
  toCpuPersonalitySnapshot,
} = domain;

interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  n: number;
}

function percentiles(valuesMs: number[]): Percentiles {
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted.length === 0
      ? 0
      : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), n: sorted.length };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = Date.now();
  const value = await fn();
  return { ms: Date.now() - start, value };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixture plans: total roster slots per team == rounds (every pick must have
// a legal slot; league validation requires total <= rounds).
// ---------------------------------------------------------------------------

type SlotPosition = "PG" | "SG" | "SF" | "PF" | "C" | "G" | "F" | "UTIL" | "BENCH";

interface TeamPlan {
  teams: number;
  rounds: number;
  slots: { position: SlotPosition; count: number; starter: boolean }[];
}

function planFor(teams: number): TeamPlan {
  const full: { position: SlotPosition; count: number; starter: boolean }[] = [
    { position: "PG", count: 1, starter: true },
    { position: "SG", count: 1, starter: true },
    { position: "SF", count: 1, starter: true },
    { position: "PF", count: 1, starter: true },
    { position: "C", count: 1, starter: true },
    { position: "G", count: 1, starter: true },
    { position: "F", count: 1, starter: true },
  ];
  switch (teams) {
    case 8:
      return {
        teams,
        rounds: 16,
        slots: [
          ...full,
          { position: "UTIL", count: 5, starter: true },
          { position: "BENCH", count: 4, starter: false },
        ],
      };
    case 10:
      return {
        teams,
        rounds: 14,
        slots: [
          ...full,
          { position: "UTIL", count: 3, starter: true },
          { position: "BENCH", count: 4, starter: false },
        ],
      };
    case 12:
    case 14:
      return {
        teams,
        rounds: 12,
        slots: [
          ...full,
          { position: "UTIL", count: 2, starter: true },
          { position: "BENCH", count: 3, starter: false },
        ],
      };
    case 16:
      return {
        teams,
        rounds: 10,
        slots: [
          { position: "PG", count: 1, starter: true },
          { position: "SG", count: 1, starter: true },
          { position: "SF", count: 1, starter: true },
          { position: "PF", count: 1, starter: true },
          { position: "C", count: 1, starter: true },
          { position: "UTIL", count: 2, starter: true },
          { position: "BENCH", count: 3, starter: false },
        ],
      };
    default:
      throw new Error(`no plan for ${String(teams)} teams`);
  }
}

const SCORING = [
  { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "REB", weight: 1.2, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "AST", weight: 1.5, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "TOV", weight: -1, direction: "LOWER_BETTER", enabled: true, punt: false },
] as const;

// ---------------------------------------------------------------------------
// Synthetic deterministic 600-player universe (pure-engine scaling).
// Illustrative values only — labeled synthetic, never cited as real data.
// ---------------------------------------------------------------------------

function syntheticUniverse(): {
  players: EnginePlayerMeta[];
  projections: EngineProjection[];
  adp: EngineAdpEntry[];
} {
  const rand = mulberry32(20260908);
  const positions = ["PG", "SG", "SF", "PF", "C"];
  const players = [];
  const projections = [];
  const adp = [];
  for (let i = 0; i < 600; i++) {
    const id = `syn-${String(i).padStart(4, "0")}`;
    const primary = positions[i % positions.length] ?? "SG";
    const secondary = positions[(i + 1) % positions.length] ?? "SF";
    const games = 50 + Math.floor(rand() * 32);
    const mpg = 18 + rand() * 18;
    const pts = 6 + rand() * 22;
    players.push({
      playerId: id,
      displayName: `Synthetic Player ${String(i)}`,
      eligiblePositions: [primary, ...(primary === secondary ? [] : [secondary])],
      status: "ACTIVE" as const,
      age: 20 + Math.floor(rand() * 15),
    });
    projections.push({
      playerId: id,
      games,
      minutesPerGame: mpg,
      pts: pts * games,
      reb: (2 + rand() * 8) * games,
      ast: (1 + rand() * 7) * games,
      stl: (0.3 + rand() * 1.4) * games,
      blk: (0.2 + rand() * 1.6) * games,
      tov: (0.8 + rand() * 2.2) * games,
      fgm: pts * 0.42 * games,
      fga: pts * 0.95 * games,
      ftm: (1 + rand() * 3.5) * games,
      fta: (1.4 + rand() * 4.2) * games,
      threePm: rand() * 2.8 * games,
      lower80: { pts: pts * games * 0.8 },
      upper80: { pts: pts * games * 1.2 },
      injuryRisk: rand() * 0.4,
      consistency: 0.3 + rand() * 0.6,
      upside: rand(),
      roleSecurity: 0.4 + rand() * 0.6,
    });
    adp.push({ playerId: id, adp: i + 1 + rand(), rank: i + 1, sourcesCount: 2 });
  }
  return { players, projections, adp };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const withIngest = process.argv.includes("--with-ingest");
  const commit = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
  const machine = `${platform()}/${release()} ${cpus()[0]?.model ?? "unknown-cpu"}`;

  // --- optional ingestion stage (timed demo:ingest) -------------------------
  let ingestion: Record<string, unknown> | null = null;
  if (withIngest) {
    const start = Date.now();
    execSync("bash scripts/demo-ingest.sh", { cwd: REPO_ROOT, stdio: "pipe" });
    const elapsedMs = Date.now() - start;
    const run = await prisma.projectionRun.findFirst({
      where: { season: "2026-27", isCurrent: true },
      select: { id: true },
    });
    const playerCount = await prisma.playerProjection.count({
      where: { runId: run?.id ?? "" },
    });
    ingestion = {
      stage: "demo:ingest (ingest + publish, demo-scale)",
      wallMs: elapsedMs,
      records: playerCount,
      recordsPerSecond:
        elapsedMs > 0 ? Math.round((playerCount / (elapsedMs / 1000)) * 10) / 10 : null,
      projectionRunId: run?.id ?? null,
      note: "Local demo pipeline only — not a production ingestion-SLO claim.",
    };
  }

  const currentRun = await prisma.projectionRun.findFirst({
    where: { season: "2026-27", isCurrent: true },
    select: { id: true, model: { select: { modelKey: true, version: true } } },
  });
  if (!currentRun) throw new Error("no published projection run — run demo:ingest first");
  const adpSnapshot = await prisma.adpConsensusSnapshot.findFirst({
    where: { season: "2026-27" },
    orderBy: { capturedAt: "desc" },
    select: { id: true },
  });
  const demoPoolSize = await prisma.playerProjection.count({ where: { runId: currentRun.id } });

  const owner = await prisma.user.create({
    data: { clerkUserId: `bench-matrix-${String(Date.now())}` },
    select: { id: true },
  });
  const createdLeagueIds: string[] = [];
  const createdDraftIds: string[] = [];

  const teamResults: Record<string, unknown> = {};
  try {
    for (const teamCount of [8, 10, 12, 14, 16]) {
      const plan = planFor(teamCount);
      const total = plan.teams * plan.rounds;
      const league = await createLeague(owner.id, {
        name: `Matrix ${String(teamCount)}x${String(plan.rounds)}`,
        season: "2026-27",
        teamCount: plan.teams,
        userDraftSlot: 1,
        rounds: plan.rounds,
        config: {
          type: "POINTS",
          horizon: "REDRAFT",
          playoffWeeks: null,
          scoringRules: [...SCORING],
          rosterSlots: plan.slots.map((s) => ({
            position: s.position,
            count: s.count,
            starter: s.starter,
          })),
        },
      });
      createdLeagueIds.push(league.id);
      const draft = await createDraft(owner.id, {
        leagueId: league.id,
        type: "MOCK",
        simulationSeed: `MATRIX-${String(teamCount)}`,
        cpuPersonalityKey: "adp-follower",
      });
      createdDraftIds.push(draft.id);
      await transitionStatus({ draftId: draft.id, ownerId: owner.id, action: "start" });

      const pickTimes: number[] = [];
      const coldTimes: number[] = [];
      const warmTimes: number[] = [];
      const mockStart = Date.now();
      let guard = 0;
      let midMeasured = false;
      while (guard < total * 2 + 4) {
        guard += 1;
        const row = await prisma.draft.findUniqueOrThrow({
          where: { id: draft.id },
          select: { nextOverallPick: true, version: true, status: true },
        });
        if (row.status !== "ACTIVE" || row.nextOverallPick > total) break;
        if (!midMeasured && row.nextOverallPick > Math.floor(total / 2)) {
          for (let s = 0; s < 5; s++) {
            coldTimes.push(
              (await timed(() => getRecommendationsForOwner(draft.id, owner.id, { force: true })))
                .ms,
            );
            warmTimes.push((await timed(() => getRecommendationsForOwner(draft.id, owner.id))).ms);
          }
          midMeasured = true;
        }
        const slot = overallPickToSlot(row.nextOverallPick, teamCount);
        if (slot === 1) {
          const recs = await getRecommendationsForOwner(draft.id, owner.id);
          const top = recs?.output.top3[0];
          if (!top) break;
          const key = `matrix-${String(teamCount)}-${String(guard)}`;
          pickTimes.push(
            (
              await timed(() =>
                makePick({
                  draftId: draft.id,
                  ownerId: owner.id,
                  playerId: top.playerId,
                  idempotencyKey: key,
                  ifMatchVersion: row.version,
                }),
              )
            ).ms,
          );
        } else {
          await makeCpuPickForOwner(
            draft.id,
            owner.id,
            `matrix-cpu-${String(teamCount)}-${String(guard)}`,
            row.version,
          );
        }
      }
      const fullMockMs = Date.now() - mockStart;
      await transitionStatus({ draftId: draft.id, ownerId: owner.id, action: "complete" });

      const analysisTimes: number[] = [];
      for (let s = 0; s < 2; s++) {
        analysisTimes.push(
          (await timed(() => getOrGenerateAnalysisForOwner(draft.id, owner.id))).ms,
        );
      }
      const historyTimes: number[] = [];
      for (let s = 0; s < 10; s++) {
        historyTimes.push((await timed(() => listHistoryForOwner(owner.id, { limit: 20 }))).ms);
      }
      const replayTimes: number[] = [];
      for (let s = 0; s < 5; s++) {
        replayTimes.push((await timed(() => listEventsForOwner(draft.id, owner.id))).ms);
      }
      const integrity = await verifyReplayIntegrity(draft.id);

      const shareCreate = await timed(() => createOrRotateShareForOwner(draft.id, owner.id));
      const lookupTimes: number[] = [];
      for (let s = 0; s < 5; s++) {
        lookupTimes.push((await timed(() => lookupSharedResult(shareCreate.value.token))).ms);
      }
      const shareRevoke = await timed(() => revokeShareForOwner(draft.id, owner.id));

      teamResults[String(teamCount)] = {
        fixture: `${String(teamCount)} teams x ${String(plan.rounds)} rounds (${String(total)} picks), demo pool (${String(demoPoolSize)} players), seed MATRIX-${String(teamCount)}`,
        coldRecommendationMs: percentiles(coldTimes),
        warmRecommendationMs: percentiles(warmTimes),
        pickMutationMs: percentiles(pickTimes),
        fullMockCompletionMs: fullMockMs,
        analysisMs: { first: analysisTimes[0] ?? 0, cached: analysisTimes[1] ?? 0 },
        historyMs: percentiles(historyTimes),
        eventReplayMs: percentiles(replayTimes),
        replayIntegrityOk: integrity.ok,
        shareCreateMs: shareCreate.ms,
        shareLookupMs: percentiles(lookupTimes),
        shareRevokeMs: shareRevoke.ms,
      };
    }

    // --- pure-engine 600-player scaling (synthetic, no DB) -------------------
    const syn = syntheticUniverse();
    const synSettings: EngineSettings = {
      season: "2026-27",
      type: "POINTS",
      horizon: "REDRAFT",
      teamCount: 12,
      rounds: 14,
      userDraftSlot: 1,
      scoringRules: [...SCORING],
      rosterSlots: [
        { position: "PG", count: 1, isStarter: true },
        { position: "SG", count: 1, isStarter: true },
        { position: "SF", count: 1, isStarter: true },
        { position: "PF", count: 1, isStarter: true },
        { position: "C", count: 1, isStarter: true },
        { position: "UTIL", count: 5, isStarter: true },
        { position: "BENCH", count: 4, isStarter: false },
      ],
    };
    const engineInput = {
      settings: synSettings,
      projectionRunId: "synthetic-600",
      modelVersion: "synthetic@1",
      projections: syn.projections,
      players: syn.players,
      adp: syn.adp,
      draftedAssignments: [],
      nextOverallPick: 84,
      picksUntilUserTurn: 5,
      includeUnsigned: false,
      engineSeed: 20260908,
    };
    const recommendTimes: number[] = [];
    for (let s = 0; s < 5; s++) {
      const start = Date.now();
      recommend(structuredClone(engineInput));
      recommendTimes.push(Date.now() - start);
    }
    const definition = cpuPersonalityByKey("balanced");
    if (!definition) throw new Error("balanced personality missing");
    const personality = toCpuPersonalitySnapshot(definition);
    const cpuTimes: number[] = [];
    for (let s = 0; s < 10; s++) {
      const start = Date.now();
      const decision = selectCpuPick({
        settings: synSettings,
        projectionRunId: "synthetic-600",
        modelVersion: "synthetic@1",
        projections: syn.projections,
        players: syn.players,
        adp: syn.adp,
        assignments: [],
        currentTeamSlot: overallPickToSlot(84 + s, 12),
        nextOverallPick: 84 + s,
        personality,
        draftSeed: 20260908,
        includeUnsigned: false,
      });
      if (!decision.ok) throw new Error("synthetic cpu selection failed");
      cpuTimes.push(Date.now() - start);
    }
    const synAssignments = Array.from({ length: 100 }, (_, i) => ({
      playerId: syn.players[i]?.playerId ?? "",
      teamSlot: overallPickToSlot(i + 1, 12),
      slotPosition: "UTIL",
      overallPick: i + 1,
      isBench: false,
      isKeeper: false,
    }));
    const analysisInput: Analysis.AnalysisInput = {
      settings: {
        season: synSettings.season,
        type: synSettings.type,
        horizon: synSettings.horizon,
        teamCount: synSettings.teamCount,
        rounds: synSettings.rounds,
        userDraftSlot: synSettings.userDraftSlot,
        scoringRules: [...SCORING],
        rosterSlots: synSettings.rosterSlots.map((s) => ({
          position: s.position,
          count: s.count,
          isStarter: s.isStarter,
        })),
      },
      players: syn.players,
      projections: syn.projections,
      adp: syn.adp,
      assignments: synAssignments,
      userTeamSlot: 1,
      projectionRunId: "synthetic-600",
      adpSnapshotId: "synthetic-600",
      engineVersion: ENGINE_VERSION,
      simulationSeed: "MATRIX-SYN-600",
    };
    const analysisTimes600: number[] = [];
    for (let s = 0; s < 3; s++) {
      const start = Date.now();
      analyzeDraft(structuredClone(analysisInput));
      analysisTimes600.push(Date.now() - start);
    }
    const synEvents = Array.from({ length: 170 }, (_, i) => ({
      sequence: i + 1,
      eventType: i === 0 ? "DRAFT_STARTED" : "PLAYER_DRAFTED",
      eventId: `syn-event-${String(i + 1)}`,
      causationEventId: null,
      teamSlot: i === 0 ? null : overallPickToSlot(i, 12),
      playerId: i === 0 ? null : (syn.players[i - 1]?.playerId ?? null),
      slotPosition: i === 0 ? null : "UTIL",
      isBench: false,
      isKeeper: false,
    }));
    const replayTimes600: number[] = [];
    for (let s = 0; s < 5; s++) {
      const start = Date.now();
      replayFull(synEvents, 12);
      replayTimes600.push(Date.now() - start);
    }

    const fixtureDescriptor = {
      teams: [8, 10, 12, 14, 16],
      demoPoolSize,
      syntheticPoolSize: 600,
      projectionRunId: currentRun.id,
      modelVersion: `${currentRun.model.modelKey}@${currentRun.model.version}`,
      adpSnapshotId: adpSnapshot?.id ?? null,
      engineVersion: ENGINE_VERSION,
    };
    const result = {
      date: new Date().toISOString(),
      machine,
      runtime: `node ${process.version}`,
      os: `${platform()} ${release()}`,
      commit,
      dataset: { ...fixtureDescriptor, fixtureChecksum: sha256(JSON.stringify(fixtureDescriptor)) },
      thresholds: {
        warmRecommendationP95UnderMs: 300,
        coldRecommendationP95UnderMs: 800,
        pickMutationP95UnderMs: 250,
      },
      teams: teamResults,
      synthetic600: {
        note: "Deterministic synthetic pool (mulberry32 20260908) — scaling signal only, not real data.",
        recommendMs: percentiles(recommendTimes),
        cpuSelectMs: percentiles(cpuTimes),
        analysisMs: percentiles(analysisTimes600),
        replayFull170EventsMs: percentiles(replayTimes600),
      },
      ingestion,
      limitations: [
        "Local Docker Postgres on a laptop — not production capacity evidence.",
        "Demo pool is 239 synthetic players; 600-player figures are synthetic pure-engine scaling.",
        "Percentile sample counts are small (n recorded per row); p99 ≈ max at these n.",
        "Full-mock completion includes recommendation reads for user turns (orchestration cost, not pure CPU).",
      ],
    };

    mkdirSync("../../docs/benchmarks", { recursive: true });
    writeFileSync(
      join("../../docs/benchmarks/team-matrix-latest.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.info(JSON.stringify(result, null, 2)); // eslint-disable-line no-console -- benchmark output is the deliverable
  } finally {
    for (const draftId of createdDraftIds) {
      await prisma.draftOutbox.deleteMany({ where: { draftId } }).catch(() => undefined);
      await prisma.recommendationSnapshot.deleteMany({ where: { draftId } }).catch(() => undefined);
      await prisma.draftRosterAssignment.deleteMany({ where: { draftId } }).catch(() => undefined);
      await prisma.draftEvent.deleteMany({ where: { draftId } }).catch(() => undefined);
      await prisma.draftTeam.deleteMany({ where: { draftId } }).catch(() => undefined);
      await prisma.draftShareCapability.deleteMany({ where: { draftId } }).catch(() => undefined);
      await prisma.draft.deleteMany({ where: { id: draftId } }).catch(() => undefined);
    }
    for (const leagueId of createdLeagueIds) {
      await prisma.scoringRule
        .deleteMany({ where: { settingsVersion: { leagueId } } })
        .catch(() => undefined);
      await prisma.rosterSlotRule
        .deleteMany({ where: { settingsVersion: { leagueId } } })
        .catch(() => undefined);
      await prisma.leagueSettingsVersion.deleteMany({ where: { leagueId } }).catch(() => undefined);
      await prisma.leagueTeam.deleteMany({ where: { leagueId } }).catch(() => undefined);
      await prisma.league.deleteMany({ where: { id: leagueId } }).catch(() => undefined);
    }
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
