import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@draftcourt/db";
import {
  applyPreset,
  getPreset,
  preferenceSettingsSchema,
  reciprocalRankWeights,
} from "@draftcourt/domain";
import { writeAuditLog } from "@/lib/server/audit-log";
import {
  assertPreferenceMutationRate,
  createProfile,
  deleteProfile,
  getDefaultProfile,
  getProfile,
  listProfiles,
  ProfileNameConflictError,
  PreferenceNotFoundError,
  RateLimitedError,
  updateProfile,
} from "@/lib/server/preference-profiles";

/**
 * Database-backed tests against the real local Postgres (same pattern as
 * leagues.test.ts). Covers owner isolation/enumeration resistance, the
 * single-default invariant backed by the partial unique index, safe delete +
 * promotion, list replacement, retired-player rejection, name conflicts, and
 * the Postgres-count mutation rate limit.
 */
function getWinNowPreset() {
  const preset = getPreset("win-now");
  if (preset === undefined) throw new Error("win-now preset missing");
  return preset;
}

describe("preference profiles service", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let playerId: string;
  let retiredPlayerId: string;
  let teamId: string;
  const createdProfileIds: string[] = [];
  const createdUserIds: string[] = [];

  async function newUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { clerkUserId: `test-pref-${crypto.randomUUID()}` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  beforeAll(async () => {
    ownerId = await newUser();
    otherOwnerId = await newUser();
    const suffix = crypto.randomUUID();
    const player = await prisma.player.create({
      data: {
        slug: `test-pref-player-${suffix}`,
        displayName: "Pref Test Player",
        legalName: "Pref Test Player",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    playerId = player.id;
    const retired = await prisma.player.create({
      data: {
        slug: `test-pref-retired-${suffix}`,
        displayName: "Retired Test Player",
        legalName: "Retired Test Player",
        status: "RETIRED",
      },
      select: { id: true },
    });
    retiredPlayerId = retired.id;
    const team = await prisma.nbaTeam.create({
      data: {
        nbaProviderId: `test-pref-team-${suffix}`,
        city: "Test",
        name: `Team ${suffix.slice(0, 6)}`,
        abbreviation: `T${suffix.slice(0, 2).toUpperCase()}${suffix.slice(2, 4).toUpperCase()}`,
        conference: "East",
        division: "Test",
        colorPrimary: "#000000",
        colorSecondary: "#111111",
      },
      select: { id: true },
    });
    teamId = team.id;
  });

  afterAll(async () => {
    await prisma.preferencePlayer.deleteMany({ where: { profileId: { in: createdProfileIds } } });
    await prisma.preferenceTeam.deleteMany({ where: { profileId: { in: createdProfileIds } } });
    await prisma.preferenceProfile.deleteMany({
      where: { ownerId: { in: [ownerId, otherOwnerId] } },
    });
    await prisma.auditLog.deleteMany({ where: { actorId: ownerId } });
    await prisma.player.deleteMany({ where: { id: { in: [playerId, retiredPlayerId] } } });
    await prisma.nbaTeam.delete({ where: { id: teamId } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("creates a blank profile that becomes the owner's default automatically", async () => {
    const detail = await createProfile(ownerId, { name: "Main", isDefault: false });
    createdProfileIds.push(detail.id);
    expect(detail.settings.schemaVersion).toBe(1);
    expect(detail.isDefault).toBe(true);
    expect(await getDefaultProfile(ownerId)).toMatchObject({ id: detail.id });
  });

  it("creates from a preset with provenance and exact reciprocal-rank weights", async () => {
    const detail = await createProfile(ownerId, {
      name: "BPA",
      isDefault: false,
      preset: { key: "bpa" },
    });
    createdProfileIds.push(detail.id);
    expect(detail.presetKey).toBe("bpa");
    expect(detail.presetVersion).toBe(1);
    const bpa = getPreset("bpa");
    if (bpa?.factorPriority === undefined) throw new Error("bpa preset missing priority");
    expect(detail.settings.factorWeights).toEqual(reciprocalRankWeights(bpa.factorPriority));
    expect(preferenceSettingsSchema.safeParse(detail.settings).success).toBe(true);
  });

  it("rejects duplicate names per owner but allows them across owners", async () => {
    await expect(createProfile(ownerId, { name: "Main", isDefault: false })).rejects.toBeInstanceOf(
      ProfileNameConflictError,
    );
    const other = await createProfile(otherOwnerId, { name: "Main", isDefault: false });
    createdProfileIds.push(other.id);
    expect(other.id).toBeTruthy();
  });

  it("enforces at-most-one default via the swap-in transaction", async () => {
    const third = await createProfile(ownerId, { name: "Third", isDefault: true });
    createdProfileIds.push(third.id);
    expect(third.isDefault).toBe(true);
    const def = await getDefaultProfile(ownerId);
    expect(def?.id).toBe(third.id);
    const all = await listProfiles(ownerId);
    expect(all.profiles.filter((profile) => profile.isDefault)).toHaveLength(1);
  });

  it("hides other owners' profiles (enumeration resistance)", async () => {
    const mine = await listProfiles(ownerId);
    expect(mine.profiles.length).toBeGreaterThan(0);
    const firstId = mine.profiles[0]?.id;
    if (firstId === undefined) throw new Error("expected at least one profile");
    const foreign = await getProfile(otherOwnerId, firstId);
    expect(foreign).toBeNull();
    await expect(updateProfile(otherOwnerId, firstId, { name: "Hijack" })).rejects.toBeInstanceOf(
      PreferenceNotFoundError,
    );
    await expect(deleteProfile(otherOwnerId, firstId)).rejects.toBeInstanceOf(
      PreferenceNotFoundError,
    );
  });

  it("updates settings, lists, and replaces entries transactionally", async () => {
    const target = await createProfile(ownerId, {
      name: "Editable",
      isDefault: false,
      preset: { key: "balanced" },
    });
    createdProfileIds.push(target.id);

    const updated = await updateProfile(target.id ? ownerId : ownerId, target.id, {
      settings: applyPreset(getWinNowPreset()),
      playerPreferences: [{ playerId, listType: "TARGET", magnitude: 0.8 }],
      teamPreferences: [{ teamId, listType: "FAVORITE", magnitude: 0.5 }],
    });
    expect(updated.presetKey).toBeNull(); // explicit settings clear provenance
    expect(updated.settings.riskTolerance).toBeLessThan(0.5);
    expect(updated.playerPreferences).toEqual([{ playerId, listType: "TARGET", magnitude: 0.8 }]);
    expect(updated.teamPreferences).toHaveLength(1);

    // Replacing with an empty array clears the lists.
    const cleared = await updateProfile(ownerId, target.id, { playerPreferences: [] });
    expect(cleared.playerPreferences).toEqual([]);
  });

  it("rejects invalid magnitudes, unknown players, and retired players", async () => {
    const profile = await createProfile(ownerId, { name: "Validation", isDefault: false });
    createdProfileIds.push(profile.id);

    await expect(
      updateProfile(ownerId, profile.id, {
        playerPreferences: [{ playerId: crypto.randomUUID(), listType: "TARGET", magnitude: 0.5 }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { playerPreferences: ["unknown player"] } });

    await expect(
      updateProfile(ownerId, profile.id, {
        playerPreferences: [{ playerId: retiredPlayerId, listType: "AVOID", magnitude: -0.9 }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { playerPreferences: [/retired/] } });

    await expect(
      updateProfile(ownerId, profile.id, {
        playerPreferences: [{ playerId, listType: "TARGET", magnitude: -0.5 }],
      }),
    ).rejects.toMatchObject({
      fieldErrors: { "playerPreferences.0.magnitude": [/must be greater than 0/] },
    });

    await expect(
      updateProfile(ownerId, profile.id, {
        teamPreferences: [{ teamId: crypto.randomUUID(), listType: "DISLIKED", magnitude: -1 }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { teamPreferences: ["unknown team"] } });
  });

  it("deletes safely and promotes the most recent remaining profile to default", async () => {
    const keeperA = await createProfile(ownerId, { name: "Keeper A", isDefault: false });
    createdProfileIds.push(keeperA.id);
    const keeperB = await createProfile(ownerId, { name: "Keeper B", isDefault: false });
    createdProfileIds.push(keeperB.id);
    await updateProfile(ownerId, keeperA.id, { isDefault: true });

    const result = await deleteProfile(ownerId, keeperA.id);
    expect(result.deletedId).toBe(keeperA.id);
    expect(result.promotedDefaultName).toBe("Keeper B");
    expect((await getDefaultProfile(ownerId))?.id).toBe(keeperB.id);

    // Deleting a missing/foreign id stays 404.
    await expect(deleteProfile(ownerId, crypto.randomUUID())).rejects.toBeInstanceOf(
      PreferenceNotFoundError,
    );
  });

  it("rate-limits mutations using the Postgres count window", async () => {
    for (let index = 0; index < 30; index += 1) {
      await writeAuditLog({
        actorId: ownerId,
        action: "preference.profile_updated",
        entityType: "UserPreferenceProfile",
        entityId: "rate-test",
        before: null,
        after: null,
        traceId: `trace-${String(index)}`,
      });
    }
    await expect(assertPreferenceMutationRate(ownerId)).rejects.toBeInstanceOf(RateLimitedError);
  });
});
