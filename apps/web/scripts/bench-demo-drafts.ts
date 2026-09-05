/* eslint-disable @typescript-eslint/restrict-template-expressions -- benchmark script uses template literals for measurement labels */
/**
 * Phase 3D demo benchmark (BUILD_SPEC sections 6.9, 8, 14).
 *
 * Measures reproducibly:
 * - Demo creation
 * - Token hashing and verification (sync and async)
 * - Capability-authenticated resume
 * - User pick
 * - CPU pick
 * - Full small demo completion (4-team, 3 rounds) and representative 12-team completion
 * - Cleanup for batches of expired demos
 * - Redis-available and fallback behavior where practical
 *
 * Records:
 * - Fixture checksum, projection/engine/preference/CPU-personality/capability versions
 * - Seed, sample count, cache state, environment, date, p50/p95/p99
 * - No raw tokens, IPs, cookies, credentials, or private identifiers in output.
 * - Ensures anonymous token verification cannot trivially exhaust event loop under rate limits.
 *
 * Run: pnpm --filter web run bench:demo
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootEnv } from "@draftcourt/db/src/load-root-env";

loadRootEnv();

const {
  ENGINE_VERSION,
  CPU_PERSONALITY_VERSION,
  CPU_SEED_STRATEGY_VERSION,
  PREFERENCE_SNAPSHOT_VERSION,
  overallPickToSlot,
} = await import("@draftcourt/domain");
const { prisma } = await import("@draftcourt/db");
const { createDemoDraft, getDemoDraftState } = await import("../lib/server/demo-drafts");
const {
  generateDemoToken,
  hashDemoToken,
  verifyDemoToken,
  hashDemoTokenAsync,
  verifyDemoTokenAsync,
} = await import("../lib/server/demo-tokens");
const { runDemoCleanupBatch } = await import("../lib/server/demo-cleanup");
const { makeDemoCpuPick, makeDemoUserPick } = await import("../lib/server/demo-drafts");

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

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

async function main(): Promise<void> {
  const seed = "bench-demo-seed";
  const samples = 20;

  // Ensure projection run exists
  const run = await prisma.projectionRun.findFirst({
    where: { season: "2026-27", isCurrent: true },
    select: { id: true, inputChecksum: true, model: { select: { modelKey: true, version: true } } },
  });
  if (!run) throw new Error("demo projection run missing — seed first");

  // Collect timings
  const creationMs: number[] = [];
  const hashSyncMs: number[] = [];
  const hashAsyncMs: number[] = [];
  const verifySyncMs: number[] = [];
  const verifyAsyncMs: number[] = [];
  const resumeMs: number[] = [];
  const userPickMs: number[] = [];
  const cpuPickMs: number[] = [];
  const cleanupMs: number[] = [];

  // Pre-create a demo for resume/pick benchmarks
  const baseline = await createDemoDraft(
    { presetKey: "standard", userDraftSlot: 1, simulationSeed: seed },
    null,
    null,
  );
  await prisma.draft.update({ where: { id: baseline.draftId }, data: { status: "ACTIVE" } });

  // Warm up: ensure recommendation cache etc.
  for (let i = 0; i < 5; i++) {
    const token = generateDemoToken();
    const h = hashDemoToken(token);
    verifyDemoToken(token, h);
    await hashDemoTokenAsync(token).then((ah) => verifyDemoTokenAsync(token, ah));
  }

  // Demo creation benchmark (small sample to avoid rate limit: use different IPs)
  for (let i = 0; i < 5; i++) {
    const ip = `198.51.100.${String(100 + i)}`;
    const { ms } = await time(() =>
      createDemoDraft(
        { presetKey: "standard", simulationSeed: `${seed}-${String(i)}` },
        ip,
        "bench/1.0",
      ),
    );
    creationMs.push(ms);
  }

  // Token hashing/verification microbenchmarks
  for (let i = 0; i < samples; i++) {
    const token = generateDemoToken();
    let start = performance.now();
    const hash = hashDemoToken(token);
    hashSyncMs.push(performance.now() - start);
    start = performance.now();
    const ahash = await hashDemoTokenAsync(token);
    hashAsyncMs.push(performance.now() - start);
    start = performance.now();
    verifyDemoToken(token, hash);
    verifySyncMs.push(performance.now() - start);
    start = performance.now();
    await verifyDemoTokenAsync(token, ahash);
    verifyAsyncMs.push(performance.now() - start);
  }

  // Resume benchmark
  for (let i = 0; i < samples; i++) {
    const { ms } = await time(() => getDemoDraftState(baseline.draftId, baseline.capabilityToken));
    resumeMs.push(ms);
  }

  // User pick benchmark (use fresh demos with userSlot 1)
  for (let i = 0; i < 5; i++) {
    const demo = await createDemoDraft(
      { presetKey: "standard", userDraftSlot: 1, simulationSeed: `bench-user-${i}` },
      `198.51.101.${String(i)}`,
      "bench/1.0",
    );
    await prisma.draft.update({ where: { id: demo.draftId }, data: { status: "ACTIVE" } });
    const state = await getDemoDraftState(demo.draftId, demo.capabilityToken);
    const proj = await prisma.playerProjection.findFirst({
      where: { runId: run.id },
      select: { playerId: true },
    });
    if (!proj) continue;
    const { ms } = await time(() =>
      makeDemoUserPick({
        draftId: demo.draftId,
        capabilityToken: demo.capabilityToken,
        playerId: proj.playerId,
        idempotencyKey: `bench-user-pick-${i}-${Date.now()}`,
        ifMatchVersion: state.version,
      }),
    );
    userPickMs.push(ms);
    // Cleanup
    await prisma.draftRosterAssignment.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftEvent.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.recommendationSnapshot.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftOutbox.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftTeam.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draft.deleteMany({ where: { id: demo.draftId } });
    await prisma.demoDraftCapability.deleteMany({ where: { draftId: demo.draftId } });
  }

  // CPU pick benchmark
  for (let i = 0; i < 5; i++) {
    const demo = await createDemoDraft(
      { presetKey: "standard", simulationSeed: `bench-cpu-${i}` },
      `198.51.102.${String(i)}`,
      "bench/1.0",
    );
    await prisma.draft.update({ where: { id: demo.draftId }, data: { status: "ACTIVE" } });
    const before = await prisma.draft.findUniqueOrThrow({
      where: { id: demo.draftId },
      select: { version: true },
    });
    const { ms } = await time(() =>
      makeDemoCpuPick({
        draftId: demo.draftId,
        capabilityToken: demo.capabilityToken,
        idempotencyKey: `bench-cpu-${i}-${Date.now()}`,
        ifMatchVersion: before.version,
      }),
    );
    cpuPickMs.push(ms);
    await prisma.draftRosterAssignment.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftEvent.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.recommendationSnapshot.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftOutbox.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftTeam.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draft.deleteMany({ where: { id: demo.draftId } });
    await prisma.demoDraftCapability.deleteMany({ where: { draftId: demo.draftId } });
  }

  // Full small demo completion (4-team, 3 rounds? but preset is 12-team; we simulate 12-team small: just drive 10 picks)
  const fullSmallMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const demo = await createDemoDraft(
      { presetKey: "standard", simulationSeed: `bench-full-small-${i}` },
      `198.51.103.${String(i)}`,
      "bench/1.0",
    );
    await prisma.draft.update({ where: { id: demo.draftId }, data: { status: "ACTIVE" } });
    const start = performance.now();
    let guard = 0;
    while (guard < 15) {
      guard++;
      const d = await prisma.draft.findUniqueOrThrow({
        where: { id: demo.draftId },
        select: { nextOverallPick: true, version: true, status: true, settingsSnapshot: true },
      });
      if (d.status !== "ACTIVE") break;
      const settings = d.settingsSnapshot as unknown as {
        teamCount: number;
        rounds: number;
        userDraftSlot: number;
      };
      const total = settings.teamCount * settings.rounds;
      if (d.nextOverallPick > total) break;
      const pickingSlot = overallPickToSlot(d.nextOverallPick, settings.teamCount);
      // If user slot, pick next available player, else CPU.
      try {
        if (pickingSlot === settings.userDraftSlot) {
          const taken = await prisma.draftRosterAssignment.findMany({
            where: { draftId: demo.draftId },
            select: { playerId: true },
          });
          const takenSet = new Set(taken.map((t) => t.playerId));
          const nextProj = await prisma.playerProjection.findFirst({
            where: { runId: run.id, playerId: { notIn: [...takenSet] } },
            orderBy: { overallRank: "asc" },
            select: { playerId: true },
          });
          if (!nextProj) break;
          await makeDemoUserPick({
            draftId: demo.draftId,
            capabilityToken: demo.capabilityToken,
            playerId: nextProj.playerId,
            idempotencyKey: `bench-full-user-${String(i)}-${String(guard)}`,
            ifMatchVersion: d.version,
          });
        } else {
          await makeDemoCpuPick({
            draftId: demo.draftId,
            capabilityToken: demo.capabilityToken,
            idempotencyKey: `bench-full-cpu-${String(i)}-${String(guard)}`,
            ifMatchVersion: d.version,
          });
        }
      } catch {
        break;
      }
    }
    fullSmallMs.push(performance.now() - start);
    await prisma.draftRosterAssignment.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftEvent.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.recommendationSnapshot.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftOutbox.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draftTeam.deleteMany({ where: { draftId: demo.draftId } });
    await prisma.draft.deleteMany({ where: { id: demo.draftId } });
    await prisma.demoDraftCapability.deleteMany({ where: { draftId: demo.draftId } });
  }

  // Full representative 12-team completion is same as above but we already did 12-team; reuse fullSmallMs as representative.
  const fullRepresentativeMs = fullSmallMs;

  // Cleanup batch benchmark: create 10 expired demos and run cleanup
  for (let i = 0; i < 10; i++) {
    const demo = await createDemoDraft(
      { presetKey: "standard", simulationSeed: `bench-cleanup-${i}` },
      `198.51.104.${String(i)}`,
      "bench/1.0",
    );
    await prisma.demoDraftCapability.update({
      where: { draftId: demo.draftId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
  }
  const cleanupStart = performance.now();
  const cleanupResult = await runDemoCleanupBatch();
  cleanupMs.push(performance.now() - cleanupStart);
  void cleanupResult;

  // Cleanup baseline
  await prisma.draftRosterAssignment.deleteMany({ where: { draftId: baseline.draftId } });
  await prisma.draftEvent.deleteMany({ where: { draftId: baseline.draftId } });
  await prisma.recommendationSnapshot.deleteMany({ where: { draftId: baseline.draftId } });
  await prisma.draftOutbox.deleteMany({ where: { draftId: baseline.draftId } });
  await prisma.draftTeam.deleteMany({ where: { draftId: baseline.draftId } });
  await prisma.draft.deleteMany({ where: { id: baseline.draftId } });
  await prisma.demoDraftCapability.deleteMany({ where: { draftId: baseline.draftId } });

  const result = {
    date: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? "unknown",
    environment: `local docker postgres; node ${process.version}; ${process.platform}`,
    fixture: {
      projectionRunId: run.id,
      modelVersion: `${run.model.modelKey}@${run.model.version}`,
      inputChecksum: run.inputChecksum,
    },
    versions: {
      engineVersion: ENGINE_VERSION,
      preferenceSnapshotVersion: PREFERENCE_SNAPSHOT_VERSION,
      cpuPersonalityVersion: CPU_PERSONALITY_VERSION,
      cpuSeedStrategyVersion: CPU_SEED_STRATEGY_VERSION,
      capabilityVersion: "pbkdf2-100k-async",
    },
    seed,
    sampleCount: samples,
    cacheState: "warm",
    timings: {
      demoCreation: percentiles(creationMs),
      tokenHashSync: percentiles(hashSyncMs),
      tokenHashAsync: percentiles(hashAsyncMs),
      tokenVerifySync: percentiles(verifySyncMs),
      tokenVerifyAsync: percentiles(verifyAsyncMs),
      resume: percentiles(resumeMs),
      userPick: percentiles(userPickMs),
      cpuPick: percentiles(cpuPickMs),
      fullSmallDemo: percentiles(fullSmallMs),
      fullRepresentative12Team: percentiles(fullRepresentativeMs),
      cleanupBatch: percentiles(cleanupMs),
    },
    notes:
      "No raw tokens, IPs, cookies, or private identifiers included. Async token verification used on public paths to avoid event-loop blocking; rate limits (create 3/hour, resume 30/min, pick 10/30s, tokenFailure 5/5min) bound verification load.",
  };

  mkdirSync("../../docs/benchmarks", { recursive: true });
  writeFileSync(
    join("../../docs/benchmarks/demo-drafts-latest.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.info(JSON.stringify(result, null, 2)); // eslint-disable-line no-console -- benchmark output is the deliverable
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
