import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@draftcourt/db";
import { checksumPreferenceSnapshot, parseDraftPreferenceSnapshot } from "@draftcourt/domain";
import {
  buildSnapshotForStart,
  PreferenceSnapshotValidationError,
  previewResolvedStrategy,
  readStoredSnapshot,
} from "@/lib/server/preference-snapshot";
import {
  createDraft,
  DraftNotFoundError,
  DraftStatusError,
  getDraftForOwner,
  makePick,
  transitionStatus,
  undoPick,
} from "@/lib/server/drafts";
import { createProfile, deleteProfile, updateProfile } from "@/lib/server/preference-profiles";

/**
 * Phase 3B integration/security suite against the real local Postgres
 * (same pattern as preference-profiles.test.ts). Proves: override precedence,
 * owner isolation without enumeration oracles, atomic snapshot capture inside
 * the authoritative start transaction (including the concurrent-start race),
 * started-draft immutability across picks/undo/pause/resume, profile deletion
 * and edits after start, updated-profile-affects-new-drafts, legacy Phase 2
 * drafts without snapshots, and the SetNull league-selection cleanup.
 */

describe("preference snapshots — resolution, capture, immutability", () => {
  let ownerA: string;
  let ownerB: string;
  let leagueA: string;
  let profileX: string; // A, win-now
  let profileY: string; // A, bpa
  let profileZ: string; // B, dynasty-youth
  let playerId: string;
  const userIds: string[] = [];

  async function newUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { clerkUserId: `test-snap-${crypto.randomUUID()}` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function newLeague(ownerId: string, name: string): Promise<string> {
    const league = await prisma.league.create({
      data: {
        ownerId,
        name,
        season: "2026-27",
        type: "POINTS",
        teamCount: 4,
        userDraftSlot: 1,
        rounds: 3,
        teams: {
          create: Array.from({ length: 4 }, (_, index) => ({
            slot: index + 1,
            displayName: index === 0 ? "My Team" : `Team ${String(index + 1)}`,
            isUserTeam: index === 0,
          })),
        },
      },
      select: { id: true },
    });
    // Minimal immutable settings version so createDraft can snapshot config
    // (same shape the wizard produces: PG starter ×1, UTIL ×1).
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
        {
          settingsVersionId: version.id,
          statKey: "TOV",
          weight: -1,
          direction: "LOWER_BETTER",
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
    return league.id;
  }

  beforeAll(async () => {
    ownerA = await newUser();
    ownerB = await newUser();
    leagueA = await newLeague(ownerA, "Snap League A");
    await newLeague(ownerB, "Snap League B");

    const suffix = crypto.randomUUID();
    const player = await prisma.player.create({
      data: {
        slug: `snap-player-${suffix}`,
        displayName: "Snapshot Test Player",
        legalName: "Snapshot Test Player",
        eligibilities: {
          create: { season: "2026-27", position: "PG" },
        },
      },
      select: { id: true },
    });
    playerId = player.id;

    profileX = (
      await createProfile(ownerA, {
        name: `Snap X ${suffix.slice(0, 6)}`,
        preset: { key: "win-now" },
        isDefault: false,
      })
    ).id;
    profileY = (
      await createProfile(ownerA, {
        name: `Snap Y ${suffix.slice(0, 6)}`,
        preset: { key: "bpa" },
        isDefault: false,
      })
    ).id;
    profileZ = (
      await createProfile(ownerB, {
        name: `Snap Z ${suffix.slice(0, 6)}`,
        preset: { key: "dynasty-youth" },
        isDefault: false,
      })
    ).id;
    // The service auto-defaults the FIRST profile per owner; these tests
    // manage defaults explicitly, so clear them.
    await prisma.preferenceProfile.updateMany({
      where: { ownerId: { in: [ownerA, ownerB] } },
      data: { isDefault: false },
    });
  });

  afterAll(async () => {
    if (userIds.length === 0) return;
    const ownedDrafts = { ownerId: { in: userIds } };
    // Dependency order: materialized rows → events → outbox/snapshots →
    // teams → drafts → rules → versions → league teams → leagues → profiles.
    await prisma.draftRosterAssignment.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.draftEvent.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.recommendationSnapshot.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.draftOutbox.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.draftTeam.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.draft.deleteMany({ where: ownedDrafts });
    await prisma.scoringRule.deleteMany({
      where: { settingsVersion: { league: { ownerId: { in: userIds } } } },
    });
    await prisma.rosterSlotRule.deleteMany({
      where: { settingsVersion: { league: { ownerId: { in: userIds } } } },
    });
    await prisma.leagueSettingsVersion.deleteMany({
      where: { league: { ownerId: { in: userIds } } },
    });
    await prisma.leagueTeam.deleteMany({ where: { league: { ownerId: { in: userIds } } } });
    await prisma.league.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.preferenceProfile.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.customPlayerRank.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.playerEligibility.deleteMany({ where: { playerId } });
    await prisma.player.delete({ where: { id: playerId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("structural migration check: snapshot columns exist on drafts and leagues", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('drafts', 'leagues')
        AND column_name IN ('preferenceSnapshot', 'preferenceSnapshotVersion',
                            'preferenceSnapshotChecksum', 'preferenceSourceProfileId',
                            'overrideProfileId', 'preferredProfileId')`;
    const names = new Set(columns.map((c) => c.column_name));
    expect(names.size).toBe(6);
  });

  it("resolves DraftCourt defaults when nothing is selected anywhere", async () => {
    const tx = prisma;
    const { snapshot, checksum } = await buildSnapshotForStart(tx, {
      ownerId: ownerA,
      leagueId: leagueA,
      leaguePreferredProfileId: null,
      overrideProfileId: null,
    });
    expect(snapshot.source.kind).toBe("DRAFTCOURT_DEFAULTS");
    expect(snapshot.source.profileId).toBeNull();
    expect(snapshot.settings.puntStats).toEqual([]);
    expect(checksum).toBe(checksumPreferenceSnapshot(snapshot));
    // Content-addressed: capturedAt never participates.
    const recaptured = await buildSnapshotForStart(tx, {
      ownerId: ownerA,
      leagueId: leagueA,
      leaguePreferredProfileId: null,
      overrideProfileId: null,
    });
    expect(recaptured.checksum).toBe(checksum);
    expect(recaptured.snapshot.capturedAt).not.toBe(snapshot.capturedAt);
  });

  it("applies full precedence: default < league < override, skipping foreign ids", async () => {
    const tx = prisma;
    // Foreign override falls through to owned league selection.
    const withForeignOverride = await buildSnapshotForStart(tx, {
      ownerId: ownerA,
      leagueId: leagueA,
      leaguePreferredProfileId: profileX,
      overrideProfileId: profileZ, // belongs to owner B
    });
    expect(withForeignOverride.snapshot.source.kind).toBe("LEAGUE_SELECTION");
    expect(withForeignOverride.snapshot.source.profileId).toBe(profileX);

    // Owned override wins over league selection.
    const withOwnedOverride = await buildSnapshotForStart(tx, {
      ownerId: ownerA,
      leagueId: leagueA,
      leaguePreferredProfileId: profileX,
      overrideProfileId: profileY,
    });
    expect(withOwnedOverride.snapshot.source.kind).toBe("DRAFT_OVERRIDE");
    expect(withOwnedOverride.snapshot.source.profileId).toBe(profileY);

    // Foreign league selection falls through to the owner's DEFAULT profile…
    await prisma.preferenceProfile.update({
      where: { id: profileY },
      data: { isDefault: true },
    });
    const withForeignLeague = await buildSnapshotForStart(tx, {
      ownerId: ownerA,
      leagueId: leagueA,
      leaguePreferredProfileId: profileZ,
      overrideProfileId: null,
    });
    expect(withForeignLeague.snapshot.source.kind).toBe("USER_DEFAULT");
    expect(withForeignLeague.snapshot.source.profileId).toBe(profileY);
    await prisma.preferenceProfile.update({
      where: { id: profileY },
      data: { isDefault: false },
    });

    // …and different strategies hash differently.
    expect(withForeignOverride.checksum).not.toBe(withOwnedOverride.checksum);
  });

  it("fails closed at start when stored settings are malformed", async () => {
    const broken = await prisma.preferenceProfile.create({
      data: {
        ownerId: ownerA,
        name: `Broken ${crypto.randomUUID().slice(0, 6)}`,
        settingsJson: { schemaVersion: 99, garbage: true },
      },
      select: { id: true },
    });
    await expect(
      buildSnapshotForStart(prisma, {
        ownerId: ownerA,
        leagueId: leagueA,
        leaguePreferredProfileId: broken.id,
        overrideProfileId: null,
      }),
    ).rejects.toBeInstanceOf(PreferenceSnapshotValidationError);
    await prisma.preferenceProfile.delete({ where: { id: broken.id } });
  });

  it("captures the snapshot atomically at start; concurrent starts cannot double-capture", async () => {
    const draft = await createDraft(ownerA, {
      leagueId: leagueA,
      overrideProfileId: profileX,
    });
    await prisma.league.update({
      where: { id: leagueA },
      data: { preferredProfileId: profileY }, // override must WIN over this
    });

    const attempts = await Promise.allSettled([
      transitionStatus({ draftId: draft.id, ownerId: ownerA, action: "start" }),
      transitionStatus({ draftId: draft.id, ownerId: ownerA, action: "start" }),
    ]);
    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter(
      (a) => a.status === "rejected" && a.reason instanceof DraftStatusError,
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const row = await prisma.draft.findUniqueOrThrow({
      where: { id: draft.id },
      select: {
        status: true,
        engineVersion: true,
        preferenceSnapshot: true,
        preferenceSnapshotVersion: true,
        preferenceSnapshotChecksum: true,
        preferenceSourceProfileId: true,
        events: { where: { eventType: "DRAFT_STARTED" }, select: { payload: true } },
      },
    });
    expect(row.status).toBe("ACTIVE");
    expect(row.preferenceSourceProfileId).toBe(profileX); // override precedence
    expect(row.preferenceSnapshotVersion).toBe(1);
    const snapshot = parseDraftPreferenceSnapshot(row.preferenceSnapshot);
    expect(snapshot.source.kind).toBe("DRAFT_OVERRIDE");
    expect(row.preferenceSnapshotChecksum).toBe(checksumPreferenceSnapshot(snapshot));
    const payload = row.events[0]?.payload as { preferenceSnapshotChecksum?: string };
    expect(payload.preferenceSnapshotChecksum).toBe(row.preferenceSnapshotChecksum);
    // Engine version healed to the current domain constant at capture time.
    expect(row.engineVersion).toBe("phase3-preferences-1.0.0");
    expect(await prisma.draftEvent.count({ where: { draftId: draft.id } })).toBe(1);
  });

  it("keeps started drafts immutable across picks/undo/pause/resume while edits affect only NEW drafts", async () => {
    const draft = await createDraft(ownerA, {
      leagueId: leagueA,
      overrideProfileId: profileX,
    });
    await transitionStatus({ draftId: draft.id, ownerId: ownerA, action: "start" });
    const before = await prisma.draft.findUniqueOrThrow({
      where: { id: draft.id },
      select: { preferenceSnapshotChecksum: true },
    });

    // Edit the source profile after start.
    await updateProfile(ownerA, profileX, { preset: { key: "high-upside" } });

    // Pick, undo, pause, resume.
    await makePick({
      draftId: draft.id,
      ownerId: ownerA,
      playerId,
      idempotencyKey: `snap-pick-${crypto.randomUUID()}`,
      ifMatchVersion: 1,
    });
    const midVersion = (
      await prisma.draft.findUniqueOrThrow({ where: { id: draft.id }, select: { version: true } })
    ).version;
    await undoPick({
      draftId: draft.id,
      ownerId: ownerA,
      idempotencyKey: `snap-undo-${crypto.randomUUID()}`,
      ifMatchVersion: midVersion,
    });
    await transitionStatus({ draftId: draft.id, ownerId: ownerA, action: "pause" });
    await transitionStatus({ draftId: draft.id, ownerId: ownerA, action: "resume" });

    const after = await prisma.draft.findUniqueOrThrow({
      where: { id: draft.id },
      select: { preferenceSnapshotChecksum: true },
    });
    expect(after.preferenceSnapshotChecksum).toBe(before.preferenceSnapshotChecksum);

    // The read model still serves the ORIGINAL strategy evidence (override
    // of profile X captured at start).
    const view = await getDraftForOwner(draft.id, ownerA);
    expect(view?.strategy?.status).toBe("OK");
    expect(view?.strategy?.source.kind).toBe("DRAFT_OVERRIDE");
    expect(view?.strategy?.source.profileId).toBe(profileX);

    // A NEW draft with the same override receives the edited profile.
    const nextDraft = await createDraft(ownerA, {
      leagueId: leagueA,
      overrideProfileId: profileX,
    });
    await transitionStatus({ draftId: nextDraft.id, ownerId: ownerA, action: "start" });
    const newRow = await prisma.draft.findUniqueOrThrow({
      where: { id: nextDraft.id },
      select: { preferenceSnapshotChecksum: true },
    });
    expect(newRow.preferenceSnapshotChecksum).not.toBe(before.preferenceSnapshotChecksum);
  });

  it("survives deletion of every referenced profile (SetNull + self-contained snapshot)", async () => {
    // Throwaway profile so this test cannot disturb later cases.
    const tempProfile = (
      await createProfile(ownerA, {
        name: `Disposable ${crypto.randomUUID().slice(0, 6)}`,
        preset: { key: "low-risk" },
        isDefault: false,
      })
    ).id;
    const tempLeague = await newLeague(ownerA, "Deletion League");
    await prisma.league.update({
      where: { id: tempLeague },
      data: { preferredProfileId: tempProfile },
    });
    const draft = await createDraft(ownerA, { leagueId: tempLeague });
    await transitionStatus({ draftId: draft.id, ownerId: ownerA, action: "start" });
    const before = await prisma.draft.findUniqueOrThrow({
      where: { id: draft.id },
      select: { preferenceSnapshotChecksum: true },
    });

    await deleteProfile(ownerA, tempProfile);

    const afterRow = await prisma.draft.findUniqueOrThrow({
      where: { id: draft.id },
      select: { preferenceSnapshot: true, preferenceSnapshotChecksum: true },
    });
    expect(afterRow.preferenceSnapshotChecksum).toBe(before.preferenceSnapshotChecksum);
    // Snapshot remains valid JSON evidence even though its source is gone.
    expect(() => parseDraftPreferenceSnapshot(afterRow.preferenceSnapshot)).not.toThrow();
    const view = await getDraftForOwner(draft.id, ownerA);
    expect(view?.strategy?.source.profileName).toBeTruthy(); // label copied at start

    // League selection was cleared by SetNull; preview falls back cleanly.
    const league = await prisma.league.findUniqueOrThrow({
      where: { id: tempLeague },
      select: { preferredProfileId: true },
    });
    expect(league.preferredProfileId).toBeNull();
  });

  it("owner-isolates league selection and override validation", async () => {
    await prisma.league.update({
      where: { id: leagueA },
      data: { preferredProfileId: null },
    });
    // Owner B cannot attach B's profile to A's league (league not found).
    const leaguesService = await import("@/lib/server/leagues");
    await expect(
      leaguesService.updateLeagueMeta(ownerB, leagueA, { preferredProfileId: profileZ }),
    ).rejects.toBeInstanceOf(leaguesService.LeagueNotFoundError);
    // Owner A cannot reference B's profile.
    await expect(
      leaguesService.updateLeagueMeta(ownerA, leagueA, { preferredProfileId: profileZ }),
    ).rejects.toBeInstanceOf(leaguesService.LeagueNotFoundError);
    // Owner A CAN attach their own; foreign ids look like missing ones.
    await expect(
      createDraft(ownerA, { leagueId: leagueA, overrideProfileId: profileZ }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it("preview resolves the chain read-only; legacy drafts report no strategy", async () => {
    await prisma.league.update({
      where: { id: leagueA },
      data: { preferredProfileId: profileX },
    });
    const preview = await previewResolvedStrategy(ownerA, {
      leaguePreferredProfileId: profileX,
      leagueId: leagueA,
    });
    expect(preview.kind).toBe("LEAGUE_SELECTION");
    expect(preview.profileName).toBeTruthy();
    expect(preview.settingsSummary.topFactors.length).toBeGreaterThan(0);
    const overridden = await previewResolvedStrategy(ownerA, {
      leaguePreferredProfileId: profileX,
      overrideProfileId: profileY,
      leagueId: leagueA,
    });
    expect(overridden.kind).toBe("DRAFT_OVERRIDE");

    // Legacy Phase 2 shape: no snapshot columns populated.
    const legacy = await prisma.draft.create({
      data: {
        ownerId: ownerA,
        leagueId: leagueA,
        status: "COMPLETED",
        engineVersion: "phase2-deterministic-1.0.0",
        settingsSnapshot: {},
        currentSequence: 4,
        nextOverallPick: 5,
        version: 9,
      },
      select: { id: true },
    });
    const legacyView = await getDraftForOwner(legacy.id, ownerA);
    expect(legacyView?.strategy ?? null).toBeNull();
    expect(readStoredSnapshot(null)).toBeNull();
    await prisma.draft.delete({ where: { id: legacy.id } });
  });
});
