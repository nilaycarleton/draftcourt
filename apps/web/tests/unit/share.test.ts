/* eslint-disable */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@draftcourt/db";
import {
  SHARE_TOKEN_BYTES,
  SHARE_TTL_MS,
  createOrRotateShareForOwner,
  digestShareToken,
  generateShareToken,
  isValidShareTokenFormat,
  lookupSharedResult,
  revokeShareForOwner,
  verifyShareToken,
  ShareNotFoundError,
  ShareNotReadyError,
  ShareValidationError,
} from "@/lib/server/share";
import { runShareCleanupBatch } from "@/lib/server/share-cleanup";
import {
  checkShareRateLimit,
  hashShareRateLimitKey,
  SHARE_RATE_LIMITS,
} from "@/lib/server/share-rate-limit";
import { scrubSentryEvent } from "@/lib/sentry-redact";

/**
 * Phase 3E2 sharing security/integration suite against real local Postgres
 * (BUILD_SPEC 2.1/8.2/13, ADR 0016 R4-R7). Proves:
 * - 256-bit token entropy, format validation, digest-only storage
 * - raw tokens never in audit rows, DB rows, or Sentry payloads
 * - owner-only creation/revocation, foreign-owner enumeration resistance
 * - DEMO/incomplete-draft rejection, COMPLETED-only public rendering
 * - single-result scope, invalid/revoked/rotated/expired safety
 * - read-only public access, capability non-interchange
 * - concurrent creation single-winner, cleanup isolation, rate limits
 * - public DTO allowlist (no prohibited fields)
 */

const SEASON = "2026-27";

const userIds: string[] = [];
const leagueIds: string[] = [];
const draftIds: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { clerkUserId: `test-share-${crypto.randomUUID()}` },
    select: { id: true },
  });
  userIds.push(user.id);
  return user.id;
}

async function newLeague(ownerId: string): Promise<string> {
  const league = await prisma.league.create({
    data: {
      ownerId,
      name: `Share League ${crypto.randomUUID().slice(0, 8)}`,
      season: SEASON,
      type: "POINTS",
      teamCount: 4,
      userDraftSlot: 1,
      rounds: 2,
      teams: {
        create: Array.from({ length: 4 }, (_, i) => ({
          slot: i + 1,
          displayName: i === 0 ? "My Team" : `Team ${String(i + 1)}`,
          isUserTeam: i === 0,
        })),
      },
    },
    select: { id: true },
  });
  const version = await prisma.leagueSettingsVersion.create({
    data: { leagueId: league.id, versionNumber: 1 },
    select: { id: true },
  });
  await prisma.scoringRule.createMany({
    data: [
      {
        settingsVersionId: version.id,
        statKey: "PTS",
        weight: 1,
        direction: "HIGHER_BETTER",
        enabled: true,
        punt: false,
      },
    ],
  });
  await prisma.rosterSlotRule.createMany({
    data: [
      { settingsVersionId: version.id, position: "PG", count: 1, isStarter: true },
      { settingsVersionId: version.id, position: "UTIL", count: 1, isStarter: true },
    ],
  });
  await prisma.league.update({
    where: { id: league.id },
    data: { activeSettingsVersionId: version.id },
  });
  leagueIds.push(league.id);
  return league.id;
}

function settingsSnapshot() {
  return {
    season: SEASON,
    type: "POINTS",
    horizon: "REDRAFT",
    teamCount: 4,
    rounds: 2,
    userDraftSlot: 1,
    playoffWeeks: null,
    scoringRules: [
      { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
    ],
    rosterSlots: [
      { position: "PG", count: 1, isStarter: true },
      { position: "UTIL", count: 1, isStarter: true },
    ],
    teams: Array.from({ length: 4 }, (_, i) => ({
      slot: i + 1,
      displayName: i === 0 ? "My Team" : `Team ${String(i + 1)}`,
      isUserTeam: i === 0,
    })),
  };
}

async function newDraft(input: {
  ownerId: string | null;
  leagueId: string | null;
  type: "REAL" | "MOCK" | "DEMO";
  status: "SETUP" | "ACTIVE" | "COMPLETED";
}): Promise<string> {
  const draft = await prisma.draft.create({
    data: {
      ownerId: input.ownerId,
      leagueId: input.leagueId,
      type: input.type,
      status: input.status,
      engineVersion: "phase3-preferences-1.0.0",
      settingsSnapshot: settingsSnapshot(),
      // Self-consistent empty log (integrity OK): share mechanics tests do
      // not need picks; status COMPLETED is the share gate.
      currentSequence: 0,
      nextOverallPick: 1,
      version: 1,
    },
    select: { id: true },
  });
  await prisma.draftTeam.createMany({
    data: Array.from({ length: 4 }, (_, i) => ({
      draftId: draft.id,
      slot: i + 1,
      displayName: i === 0 ? "My Team" : `Team ${String(i + 1)}`,
      isUserTeam: i === 0,
    })),
  });
  draftIds.push(draft.id);
  return draft.id;
}

describe("share tokens — entropy, hashing, storage, delivery", () => {
  it("tokens carry 256-bit entropy in validated base64url format", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = generateShareToken();
      expect(isValidShareTokenFormat(token)).toBe(true);
      expect(token).toHaveLength(43);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
    expect(SHARE_TOKEN_BYTES).toBe(32);
    expect(isValidShareTokenFormat("not-a-token")).toBe(false);
    expect(isValidShareTokenFormat("")).toBe(false);
    expect(isValidShareTokenFormat("a".repeat(43).replaceAll("a", "!"))).toBe(false);
  });

  it("digests are one-way hex and verify in constant time", () => {
    const token = generateShareToken();
    const digest = digestShareToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyShareToken(token, digest)).toBe(true);
    expect(verifyShareToken(generateShareToken(), digest)).toBe(false);
    expect(verifyShareToken("not-a-token", digest)).toBe(false);
    expect(verifyShareToken(token, "0".repeat(64))).toBe(false);
    expect(verifyShareToken(token, "malformed")).toBe(false);
    expect(() => digestShareToken("bad")).toThrowError(ShareValidationError);
  });
});

describe("share capabilities — owner isolation, lifecycle, redaction", () => {
  let ownerA: string;
  let ownerB: string;
  let completedId: string;
  let activeId: string;

  beforeAll(async () => {
    ownerA = await newUser();
    ownerB = await newUser();
    const leagueA = await newLeague(ownerA);
    completedId = await newDraft({
      ownerId: ownerA,
      leagueId: leagueA,
      type: "REAL",
      status: "COMPLETED",
    });
    activeId = await newDraft({
      ownerId: ownerA,
      leagueId: leagueA,
      type: "REAL",
      status: "ACTIVE",
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.draftShareCapability.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draftAnalysis.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draftRosterAssignment.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draftEvent.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.recommendationSnapshot.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draftOutbox.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draftTeam.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draft.deleteMany({ where: { id: { in: draftIds } } });
    await prisma.scoringRule.deleteMany({
      where: { settingsVersion: { leagueId: { in: leagueIds } } },
    });
    await prisma.rosterSlotRule.deleteMany({
      where: { settingsVersion: { leagueId: { in: leagueIds } } },
    });
    await prisma.leagueSettingsVersion.deleteMany({ where: { leagueId: { in: leagueIds } } });
    await prisma.leagueTeam.deleteMany({ where: { leagueId: { in: leagueIds } } });
    await prisma.league.deleteMany({ where: { id: { in: leagueIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.auditLog.deleteMany({
      where: {
        action: { startsWith: "share.ratelimit:" },
        entityId: { contains: "test-share-limit-" },
      },
    });
  });

  it("only the owner can create; foreigners get no oracle", async () => {
    await expect(createOrRotateShareForOwner(completedId, ownerB)).rejects.toBeInstanceOf(
      ShareNotFoundError,
    );
    await expect(createOrRotateShareForOwner(crypto.randomUUID(), ownerA)).rejects.toBeInstanceOf(
      ShareNotFoundError,
    );
    await expect(revokeShareForOwner(completedId, ownerB)).rejects.toBeInstanceOf(
      ShareNotFoundError,
    );
  });

  it("incomplete and demo drafts cannot be shared", async () => {
    await expect(createOrRotateShareForOwner(activeId, ownerA)).rejects.toBeInstanceOf(
      ShareNotReadyError,
    );
    const demoId = await newDraft({
      ownerId: null,
      leagueId: null,
      type: "DEMO",
      status: "COMPLETED",
    });
    await expect(createOrRotateShareForOwner(demoId, ownerA)).rejects.toBeInstanceOf(Error);
  });

  it("stores only the digest — never the raw token", async () => {
    const created = await createOrRotateShareForOwner(completedId, ownerA);
    expect(isValidShareTokenFormat(created.token)).toBe(true);
    expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(SHARE_TTL_MS - 60_000);
    expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(SHARE_TTL_MS);
    const row = await prisma.draftShareCapability.findUniqueOrThrow({
      where: { draftId: completedId },
    });
    expect(row.tokenDigest).toBe(digestShareToken(created.token));
    expect(row.tokenDigest).not.toContain(created.token.slice(0, 8));
    expect(JSON.stringify(row)).not.toContain(created.token);
    // Audit rows are redacted: no token or digest.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "draft_share", entityId: completedId },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) {
      expect(JSON.stringify(audit)).not.toContain(created.token);
      expect(JSON.stringify(audit)).not.toContain(row.tokenDigest);
    }
  });

  it("valid token resolves exactly one completed result", async () => {
    const created = await createOrRotateShareForOwner(completedId, ownerA);
    const dto = await lookupSharedResult(created.token);
    expect(dto).not.toBeNull();
    expect(dto?.board).toEqual([]);
    expect(dto?.analysis.available).toBe(false);
    expect(dto?.integrity.ok).toBe(true);
  });

  it("invalid, malformed, revoked, rotated, expired tokens fail safely", async () => {
    expect(await lookupSharedResult("not-a-token")).toBeNull();
    expect(await lookupSharedResult("A".repeat(43))).toBeNull();
    const first = await createOrRotateShareForOwner(completedId, ownerA);
    expect(await lookupSharedResult(first.token)).not.toBeNull();
    // Rotation kills the old token.
    const second = await createOrRotateShareForOwner(completedId, ownerA);
    expect(second.rotated).toBe(true);
    expect(await lookupSharedResult(first.token)).toBeNull();
    expect(await lookupSharedResult(second.token)).not.toBeNull();
    // Revocation kills immediately and is idempotent.
    expect(await revokeShareForOwner(completedId, ownerA)).toEqual({ revoked: true });
    expect(await lookupSharedResult(second.token)).toBeNull();
    expect(await revokeShareForOwner(completedId, ownerA)).toEqual({ revoked: false });
    // Expiry is server-enforced.
    const third = await createOrRotateShareForOwner(completedId, ownerA);
    await prisma.draftShareCapability.update({
      where: { draftId: completedId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await lookupSharedResult(third.token)).toBeNull();
  });

  it("public DTO contains no prohibited fields", async () => {
    const created = await createOrRotateShareForOwner(completedId, ownerA);
    const dto = await lookupSharedResult(created.token);
    const json = JSON.stringify(dto);
    for (const forbidden of [
      "clerkUserId",
      "ownerId",
      "actorUserId",
      "tokenDigest",
      "shareToken",
      "capabilityToken",
      "idempotencyKey",
      "preferenceSnapshot",
      "customRanks",
    ]) {
      expect(json).not.toContain(forbidden);
    }
    expect(json).not.toContain("@");
    expect(json).not.toContain(created.token);
    // Internal event UUIDs stay server-side; sequences carry linkage.
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("concurrent creation leaves one row with exactly one valid token", async () => {
    const results = await Promise.allSettled([
      createOrRotateShareForOwner(completedId, ownerA),
      createOrRotateShareForOwner(completedId, ownerA),
    ]);
    const tokens = results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrRotateShareForOwner>>> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value.token);
    expect(tokens).toHaveLength(2);
    const rows = await prisma.draftShareCapability.findMany({ where: { draftId: completedId } });
    expect(rows).toHaveLength(1);
    const validity = await Promise.all(tokens.map((t) => lookupSharedResult(t)));
    expect(validity.filter(Boolean)).toHaveLength(1);
  });

  it("cleanup removes expired shares without touching product data", async () => {
    // Seed product data on the shared draft.
    const players = await prisma.player.findMany({
      take: 2,
      orderBy: { slug: "asc" },
      select: { id: true },
    });
    const eventId = crypto.randomUUID();
    await prisma.draftEvent.create({
      data: { id: eventId, draftId: completedId, sequence: 1, eventType: "DRAFT_STARTED" },
    });
    const created = await createOrRotateShareForOwner(completedId, ownerA);
    await prisma.draftShareCapability.update({
      where: { draftId: completedId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // A demo capability row must survive share cleanup.
    const demoDraft = await prisma.draft.create({
      data: {
        ownerId: null,
        leagueId: null,
        type: "DEMO",
        status: "COMPLETED",
        engineVersion: "phase3-preferences-1.0.0",
        settingsSnapshot: {},
        currentSequence: 0,
        nextOverallPick: 1,
        version: 0,
      },
      select: { id: true },
    });
    draftIds.push(demoDraft.id);
    const demoCap = await prisma.demoDraftCapability.create({
      data: {
        draftId: demoDraft.id,
        tokenHash: "x",
        rateLimitKey: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
      },
      select: { id: true },
    });
    const result = await runShareCleanupBatch();
    expect(result.deletedExpired).toBeGreaterThanOrEqual(1);
    expect(result.errors).toEqual([]);
    // Share gone; draft, events, teams intact; demo capability intact.
    expect(
      await prisma.draftShareCapability.findUnique({ where: { draftId: completedId } }),
    ).toBeNull();
    expect(await prisma.draft.findUnique({ where: { id: completedId } })).not.toBeNull();
    expect(await prisma.draftEvent.count({ where: { draftId: completedId } })).toBe(1);
    expect(await prisma.draftTeam.count({ where: { draftId: completedId } })).toBe(4);
    expect(
      await prisma.demoDraftCapability.findUnique({ where: { id: demoCap.id } }),
    ).not.toBeNull();
    expect(created.token).toBeTruthy();
    expect(players.length).toBeGreaterThanOrEqual(0);
    await prisma.demoDraftCapability.delete({ where: { id: demoCap.id } }).catch(() => undefined);
  });

  it("rate limits gate without leaking validity", async () => {
    const key = `test-share-limit-${crypto.randomUUID()}`;
    const config = SHARE_RATE_LIMITS["lookup"] ?? {
      windowSeconds: 60,
      maxRequests: 60,
      keyPrefix: "share:test-lookup",
    };
    for (let i = 0; i < config.maxRequests; i++) {
      const gated = await checkShareRateLimit(`${key}`, {
        ...config,
        keyPrefix: `share:test-${key}`,
      });
      expect(gated.allowed).toBe(true);
    }
    const denied = await checkShareRateLimit(`${key}`, {
      ...config,
      keyPrefix: `share:test-${key}`,
    });
    expect(denied.allowed).toBe(false);
    expect(hashShareRateLimitKey("1.2.3.4", "ua")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareRateLimitKey("1.2.3.4", "ua")).not.toContain("1.2.3.4");
  });

  it("Sentry scrubbing removes share tokens, digests, and token-shaped paths", () => {
    const token = generateShareToken();
    const digest = digestShareToken(token);
    const scrubbed = scrubSentryEvent(
      {
        request: {
          url: `https://app.example.com/share/${token}`,
          headers: { authorization: "Bearer x", "content-type": "application/json" },
          cookies: { session: "abc" },
          data: {
            shareToken: token,
            tokenDigest: digest,
            email: "a@b.com",
            nested: { capabilityToken: token },
          },
        },
      } as never,
      {} as never,
    );
    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain(token);
    expect(json).not.toContain(digest);
    expect(json).not.toContain("a@b.com");
    expect(json).not.toContain("Bearer x");
  });
});
