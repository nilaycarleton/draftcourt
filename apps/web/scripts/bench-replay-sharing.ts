/* eslint-disable no-console -- benchmark output is the deliverable */
/**
 * Phase 3E2 replay + sharing benchmark (BUILD_SPEC sections 6.9, 19).
 *
 * Measures reproducibly (computation only — presentation timing excluded,
 * fake time for replay pacing):
 * - pure replay through a standard 12x14 draft
 * - pure replay through a large 20x20 draft
 * - random sequence seek
 * - sequential playback computation (all prefixes)
 * - event pagination (owner timeline pages)
 * - first + warm shared-result lookup
 * - token digest derivation and lookup
 * - shared DTO construction
 * - cleanup batches
 * - concurrent share creation
 *
 * Records fixture checksum, event counts, draft dimensions, analysis and
 * replay versions, token algorithm (no secrets), sample counts, p50/p95/p99,
 * environment, and date. No raw tokens, digests, IPs, or owner data.
 *
 * Run: pnpm --filter web exec tsx scripts/bench-replay-sharing.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootEnv } from "@draftcourt/db/src/load-root-env";

loadRootEnv();

const { REPLAY_VERSION, replayFull, replayToSequence } = await import("@draftcourt/domain");
const { ANALYSIS_VERSION } = await import("@draftcourt/domain");
const { prisma } = await import("@draftcourt/db");
const { listTimelineEventsForOwner } = await import("../lib/server/drafts");
const { createOrRotateShareForOwner, digestShareToken, generateShareToken, lookupSharedResult } =
  await import("../lib/server/share");
const { runShareCleanupBatch } = await import("../lib/server/share-cleanup");

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

interface SyntheticEvent {
  sequence: number;
  eventType: string;
  eventId: string;
  causationEventId: string | null;
  teamSlot: number | null;
  playerId: string | null;
  slotPosition: string | null;
  isBench: boolean;
  isKeeper: boolean;
}

function buildFixture(teamCount: number, rounds: number, seedOffset: number): SyntheticEvent[] {
  const events: SyntheticEvent[] = [];
  let sequence = 1;
  const eventId = (n: number): string =>
    `00000000-0000-4000-8000-${String(seedOffset * 100000 + n).padStart(12, "0")}`;
  const playerId = (n: number): string =>
    `11111111-1111-4111-8111-${String(seedOffset * 100000 + n).padStart(12, "0")}`;
  events.push({
    sequence: sequence++,
    eventType: "DRAFT_STARTED",
    eventId: eventId(900001),
    causationEventId: null,
    teamSlot: null,
    playerId: null,
    slotPosition: null,
    isBench: false,
    isKeeper: false,
  });
  const total = teamCount * rounds;
  for (let pick = 1; pick <= total; pick++) {
    const round = Math.ceil(pick / teamCount);
    const positionInRound = ((pick - 1) % teamCount) + 1;
    const slot = round % 2 === 1 ? positionInRound : teamCount + 1 - positionInRound;
    events.push({
      sequence: sequence++,
      eventType: "PLAYER_DRAFTED",
      eventId: eventId(pick),
      causationEventId: null,
      teamSlot: slot,
      playerId: playerId(pick),
      slotPosition: "UTIL",
      isBench: false,
      isKeeper: false,
    });
  }
  events.push({
    sequence: events.length + 1,
    eventType: "DRAFT_COMPLETED",
    eventId: eventId(900002),
    causationEventId: null,
    teamSlot: null,
    playerId: null,
    slotPosition: null,
    isBench: false,
    isKeeper: false,
  });
  return events;
}

async function main(): Promise<void> {
  const samples = 20;
  const standard = buildFixture(12, 14, 1);
  const large = buildFixture(20, 20, 2);

  const standardChecksum = replayFull(standard, 12).checksum;
  const largeChecksum = replayFull(large, 20).checksum;

  const standardMs: number[] = [];
  const largeMs: number[] = [];
  const seekMs: number[] = [];
  const playbackMs: number[] = [];
  const digestMs: number[] = [];

  for (let i = 0; i < samples; i++) {
    let start = performance.now();
    replayFull(standard, 12);
    standardMs.push(performance.now() - start);

    start = performance.now();
    replayFull(large, 20);
    largeMs.push(performance.now() - start);

    // Deterministic pseudo-random seeks (no Math.random: reproducible).
    const upto = 1 + ((i * 37) % standard.length);
    start = performance.now();
    replayToSequence(standard, 12, upto);
    seekMs.push(performance.now() - start);

    // Token digest derivation (computation only).
    const token = generateShareToken();
    start = performance.now();
    digestShareToken(token);
    digestMs.push(performance.now() - start);
  }

  // Sequential playback: every prefix once (bounded fixture).
  {
    const start = performance.now();
    for (let upto = 1; upto <= standard.length; upto++) {
      replayToSequence(standard, 12, upto);
    }
    playbackMs.push(performance.now() - start);
  }

  // DB-backed measurements on an isolated fixture draft.
  const user = await prisma.user.create({
    data: { clerkUserId: `bench-share-${crypto.randomUUID()}` },
    select: { id: true },
  });
  const league = await prisma.league.create({
    data: {
      ownerId: user.id,
      name: `Bench League ${crypto.randomUUID().slice(0, 8)}`,
      season: "2026-27",
      type: "POINTS",
      teamCount: 4,
      userDraftSlot: 1,
      rounds: 4,
      teams: {
        create: Array.from({ length: 4 }, (_, i) => ({
          slot: i + 1,
          displayName: `T${String(i + 1)}`,
          isUserTeam: i === 0,
        })),
      },
    },
    select: { id: true },
  });
  const draftIds: string[] = [];
  async function benchDraft(picks: number): Promise<string> {
    const draft = await prisma.draft.create({
      data: {
        ownerId: user.id,
        leagueId: league.id,
        type: "REAL",
        status: "COMPLETED",
        engineVersion: "bench",
        settingsSnapshot: {
          season: "2026-27",
          type: "POINTS",
          horizon: "REDRAFT",
          teamCount: 4,
          rounds: 4,
          userDraftSlot: 1,
          playoffWeeks: null,
          scoringRules: [],
          rosterSlots: [],
          teams: [1, 2, 3, 4].map((slot) => ({
            slot,
            displayName: `T${String(slot)}`,
            isUserTeam: slot === 1,
          })),
        },
        currentSequence: picks + 1,
        nextOverallPick: picks + 1,
        version: 1,
      },
      select: { id: true },
    });
    await prisma.draftTeam.createMany({
      data: [1, 2, 3, 4].map((slot) => ({
        draftId: draft.id,
        slot,
        displayName: `T${String(slot)}`,
        isUserTeam: slot === 1,
      })),
    });
    await prisma.draftEvent.create({
      data: { draftId: draft.id, sequence: 1, eventType: "DRAFT_STARTED" },
    });
    for (let i = 0; i < picks; i++) {
      const eventId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      const slot = (i % 4) + 1;
      await prisma.draftEvent.create({
        data: {
          id: eventId,
          draftId: draft.id,
          sequence: i + 2,
          eventType: "PLAYER_DRAFTED",
          teamSlot: slot,
          playerId,
          round: Math.floor(i / 4) + 1,
          pickInRound: (i % 4) + 1,
          payload: { slotPosition: "UTIL", isBench: false },
        },
      });
      await prisma.draftRosterAssignment.create({
        data: {
          draftId: draft.id,
          eventId,
          teamSlot: slot,
          playerId,
          slotPosition: "UTIL",
          assignedAt: new Date(),
        },
      });
    }
    draftIds.push(draft.id);
    return draft.id;
  }

  const pagedDraftId = await benchDraft(16);
  const paginationMs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await listTimelineEventsForOwner(pagedDraftId, user.id, { limit: 10 });
    paginationMs.push(performance.now() - start);
  }

  const shareDraftId = await benchDraft(8);
  const created = await createOrRotateShareForOwner(shareDraftId, user.id);
  const firstLookupMs: number[] = [];
  const warmLookupMs: number[] = [];
  const dtoMs: number[] = [];
  {
    const start = performance.now();
    await lookupSharedResult(created.token);
    firstLookupMs.push(performance.now() - start);
  }
  for (let i = 0; i < samples; i++) {
    let start = performance.now();
    await lookupSharedResult(created.token);
    warmLookupMs.push(performance.now() - start);
    start = performance.now();
    await lookupSharedResult(created.token);
    dtoMs.push(performance.now() - start);
  }

  // Concurrent creation across separate drafts (documented winner per draft).
  const concurrentDraftIds: string[] = [];
  for (let i = 0; i < 4; i++) concurrentDraftIds.push(await benchDraft(4));
  const concurrentMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await Promise.all(concurrentDraftIds.map((id) => createOrRotateShareForOwner(id, user.id)));
    concurrentMs.push(performance.now() - start);
  }

  // Cleanup batch: expire everything share-related, then clean.
  for (const id of [...draftIds, ...concurrentDraftIds]) {
    await prisma.draftShareCapability.updateMany({
      where: { draftId: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
  }
  const cleanupMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await runShareCleanupBatch();
    cleanupMs.push(performance.now() - start);
  }

  // Teardown (share rows already cleaned; remove product rows).
  const allDraftIds = [...draftIds, ...concurrentDraftIds];
  await prisma.draftShareCapability.deleteMany({ where: { draftId: { in: allDraftIds } } });
  await prisma.draftRosterAssignment.deleteMany({ where: { draftId: { in: allDraftIds } } });
  await prisma.draftEvent.deleteMany({ where: { draftId: { in: allDraftIds } } });
  await prisma.draftTeam.deleteMany({ where: { draftId: { in: allDraftIds } } });
  await prisma.draft.deleteMany({ where: { id: { in: allDraftIds } } });
  await prisma.leagueTeam.deleteMany({ where: { leagueId: league.id } });
  await prisma.league.deleteMany({ where: { id: league.id } });
  await prisma.user.deleteMany({ where: { id: user.id } });

  const result = {
    date: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? "unknown",
    environment: `local docker postgres; node ${process.version}; ${process.platform}`,
    fixture: {
      standard: {
        teamCount: 12,
        rounds: 14,
        eventCount: standard.length,
        checksum: standardChecksum,
      },
      large: { teamCount: 20, rounds: 20, eventCount: large.length, checksum: largeChecksum },
      pagedDraftEvents: 17,
      shareDraftPicks: 8,
    },
    versions: { replayVersion: REPLAY_VERSION, analysisVersion: ANALYSIS_VERSION },
    tokenAlgorithm: "sha256-hex-digest-of-256bit-base64url (no secrets recorded)",
    sampleCount: samples,
    cacheState: "n/a (computation + direct DB reads; no presentation timing)",
    timings: {
      pureReplayStandard: percentiles(standardMs),
      pureReplayLarge: percentiles(largeMs),
      randomSequenceSeek: percentiles(seekMs),
      sequentialPlaybackAllPrefixes: percentiles(playbackMs),
      eventPagination10: percentiles(paginationMs),
      sharedLookupFirst: percentiles(firstLookupMs),
      sharedLookupWarm: percentiles(warmLookupMs),
      tokenDigestDerivation: percentiles(digestMs),
      sharedDtoConstruction: percentiles(dtoMs),
      cleanupBatch: percentiles(cleanupMs),
      concurrentShareCreation4: percentiles(concurrentMs),
    },
    notes:
      "Computation measured separately from presentation timing; replay pacing uses fixed steps (fake-time friendly). No raw tokens, digests, IPs, or owner data recorded.",
  };

  mkdirSync("../../docs/benchmarks", { recursive: true });
  writeFileSync(
    join("../../docs/benchmarks/replay-sharing-latest.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.info(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
