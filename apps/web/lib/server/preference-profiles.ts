import { z } from "zod";
import { prisma } from "@draftcourt/db";
import type { Prisma } from "@draftcourt/db";
import {
  applyPreset,
  defaultPreferenceSettings,
  getPreset,
  preferenceSettingsSchema,
  validatePuntConsistency,
  type PreferenceSettings,
} from "@draftcourt/domain";

/**
 * Preference-profile service (BUILD_SPEC.md sections 2.2 and 4.2, Phase 3A).
 *
 * Authorization model mirrors `lib/server/leagues.ts`: the route layer
 * authenticates via `getCurrentUser()`, then every query here is scoped by
 * `ownerId` — a non-owner's id resolves to the same null as a missing id, so
 * there is no enumeration oracle.
 *
 * Storage: settings persist as ONE versioned JSON envelope validated against
 * `preferenceSettingsSchema` (schemaVersion 1). Player/team preference lists
 * are relational rows (PreferencePlayer / PreferenceTeam) replaced
 * transactionally whenever a payload includes them. See ADR 0011.
 */

export class PreferenceNotFoundError extends Error {}
export class ProfileNameConflictError extends Error {}
export class PreferenceValidationError extends Error {
  constructor(
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}
export class RateLimitedError extends Error {}

function zodIssueMap(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    out[key] = [...(out[key] ?? []), issue.message];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

const preferenceListTypes = ["FAVORITE", "DISLIKED", "TARGET", "AVOID"] as const;

export const playerPreferenceEntrySchema = z
  .object({
    playerId: z.uuid(),
    listType: z.enum(preferenceListTypes),
    magnitude: z.number().min(-1).max(1),
  })
  .superRefine((entry, ctx) => {
    const positive = entry.magnitude > 0;
    const negative = entry.magnitude < 0;
    if ((entry.listType === "FAVORITE" || entry.listType === "TARGET") && !positive) {
      ctx.addIssue({
        code: "custom",
        path: ["magnitude"],
        message: `${entry.listType.toLowerCase()} magnitude must be greater than 0`,
      });
    }
    if ((entry.listType === "DISLIKED" || entry.listType === "AVOID") && !negative) {
      ctx.addIssue({
        code: "custom",
        path: ["magnitude"],
        message: `${entry.listType.toLowerCase()} magnitude must be less than 0`,
      });
    }
  });

export const teamPreferenceEntrySchema = z.object({
  teamId: z.uuid(),
  listType: z.enum(["FAVORITE", "DISLIKED"]),
  magnitude: z.number().min(-1).max(1),
});

const MAX_ENTRIES_PER_LIST = 50;
const MAX_TEAMS_PER_LIST = 8;

const playerPreferencesPayloadSchema = z
  .array(playerPreferenceEntrySchema)
  .max(MAX_ENTRIES_PER_LIST * preferenceListTypes.length)
  .refine(
    (entries) => {
      for (const listType of preferenceListTypes) {
        const count = entries.filter((entry) => entry.listType === listType).length;
        if (count > MAX_ENTRIES_PER_LIST) {
          return false;
        }
      }
      return true;
    },
    { message: `at most ${String(MAX_ENTRIES_PER_LIST)} players per list` },
  )
  .refine(
    (entries) =>
      new Set(entries.map((entry) => `${entry.playerId}:${entry.listType}`)).size ===
      entries.length,
    { message: "duplicate player/list combinations are not allowed" },
  );

const teamPreferencesPayloadSchema = z
  .array(teamPreferenceEntrySchema)
  .max(MAX_TEAMS_PER_LIST * 2)
  .refine((entries) => new Set(entries.map((entry) => entry.teamId)).size === entries.length, {
    message: "duplicate team entries are not allowed",
  });

const presetSelectionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "invalid preset key"),
});

export const createProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isDefault: z.boolean().default(false),
  preset: presetSelectionSchema.optional(),
  settings: preferenceSettingsSchema.optional(),
  playerPreferences: playerPreferencesPayloadSchema.optional(),
  teamPreferences: teamPreferencesPayloadSchema.optional(),
});
export type CreateProfileInput = z.infer<typeof createProfileSchema>;

/** PATCH accepts partial top-level fields; provided arrays REPLACE. */
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isDefault: z.boolean().optional(),
  preset: presetSelectionSchema.optional(),
  settings: preferenceSettingsSchema.optional(),
  playerPreferences: playerPreferencesPayloadSchema.optional(),
  teamPreferences: teamPreferencesPayloadSchema.optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface PlayerPreferenceView {
  playerId: string;
  listType: (typeof preferenceListTypes)[number];
  magnitude: number;
}

export interface TeamPreferenceView {
  teamId: string;
  listType: "FAVORITE" | "DISLIKED";
  magnitude: number;
}

export interface PreferenceProfileSummary {
  id: string;
  name: string;
  presetKey: string | null;
  presetVersion: number | null;
  schemaVersion: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PreferenceProfileDetail extends PreferenceProfileSummary {
  settings: PreferenceSettings;
  playerPreferences: PlayerPreferenceView[];
  teamPreferences: TeamPreferenceView[];
}

const PROFILE_SUMMARY_SELECT = {
  id: true,
  name: true,
  presetKey: true,
  presetVersion: true,
  settingsJson: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PreferenceProfileSelect;

function toSummary(row: {
  id: string;
  name: string;
  presetKey: string | null;
  presetVersion: number | null;
  settingsJson: Prisma.JsonValue;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): PreferenceProfileSummary {
  const settings = parseStoredSettings(row.settingsJson);
  return {
    id: row.id,
    name: row.name,
    presetKey: row.presetKey,
    presetVersion: row.presetVersion,
    schemaVersion: settings.schemaVersion,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(
  row: Prisma.PreferenceProfileGetPayload<{
    include: {
      playerPreferences: { select: { playerId: true; listType: true; magnitude: true } };
      teamPreferences: { select: { teamId: true; listType: true; magnitude: true } };
    };
  }>,
): PreferenceProfileDetail {
  return {
    ...toSummary(row),
    settings: parseStoredSettings(row.settingsJson),
    playerPreferences: row.playerPreferences.map((entry) => ({
      playerId: entry.playerId,
      listType: entry.listType,
      magnitude: Number(entry.magnitude),
    })),
    teamPreferences: row.teamPreferences.map((entry) => ({
      teamId: entry.teamId,
      listType: entry.listType,
      magnitude: Number(entry.magnitude),
    })),
  };
}

/** Stored JSON is re-validated on read — a schema-version bump or manual edit
 * fails closed instead of leaking malformed data into the engine later. */
function parseStoredSettings(json: Prisma.JsonValue): PreferenceSettings {
  const parsed = preferenceSettingsSchema.safeParse(json);
  if (!parsed.success) {
    throw new PreferenceValidationError("stored preference settings failed validation");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Settings resolution + validation helpers
// ---------------------------------------------------------------------------

function resolveSettings(payload: {
  preset?: { key: string } | undefined;
  settings?: PreferenceSettings | undefined;
}): { settings: PreferenceSettings; presetKey: string | null; presetVersion: number | null } {
  if (payload.settings) {
    const problem = validatePuntConsistency(payload.settings);
    if (problem) throw new PreferenceValidationError(problem, { puntStats: [problem] });
    return { settings: payload.settings, presetKey: null, presetVersion: null };
  }
  if (payload.preset) {
    const preset = getPreset(payload.preset.key);
    if (!preset) {
      throw new PreferenceValidationError(`unknown preset "${payload.preset.key}"`, {
        "preset.key": [`unknown preset — expected one of the published preset keys`],
      });
    }
    const applied = applyPreset(preset);
    // Presets are trusted data definitions, but validate anyway so a bad
    // definition can never persist.
    const parsed = preferenceSettingsSchema.safeParse(applied);
    if (!parsed.success) throw new PreferenceValidationError("preset produced invalid settings");
    return {
      settings: parsed.data,
      presetKey: preset.key,
      presetVersion: preset.version,
    };
  }
  return {
    settings: defaultPreferenceSettings(),
    presetKey: null,
    presetVersion: null,
  };
}

/** Validates player/team reference rows: existence, no retired players
 * (unsigned/injured remain rankable), bounded magnitudes by list type. */
async function validateReferenceRows(payload: {
  playerPreferences?: { playerId: string; listType: string; magnitude: number }[] | undefined;
  teamPreferences?: { teamId: string; listType: string; magnitude: number }[] | undefined;
}): Promise<void> {
  if (payload.playerPreferences?.length) {
    const ids = [...new Set(payload.playerPreferences.map((entry) => entry.playerId))];
    const rows = await prisma.player.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, displayName: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const entry of payload.playerPreferences) {
      const player = byId.get(entry.playerId);
      if (!player) {
        throw new PreferenceValidationError("one or more preferred players do not exist", {
          playerPreferences: ["unknown player"],
        });
      }
      if (player.status === "RETIRED") {
        throw new PreferenceValidationError("retired players cannot be added to preference lists", {
          playerPreferences: [`${player.displayName} is retired`],
        });
      }
    }
  }
  if (payload.teamPreferences?.length) {
    const ids = [...new Set(payload.teamPreferences.map((entry) => entry.teamId))];
    const count = await prisma.nbaTeam.count({ where: { id: { in: ids } } });
    if (count !== ids.length) {
      throw new PreferenceValidationError("one or more preferred teams do not exist", {
        teamPreferences: ["unknown team"],
      });
    }
  }
}

/** Replaces player/team preference rows inside the caller's transaction. */
type ProfileTx = Prisma.TransactionClient;

async function writeReferenceRows(
  tx: ProfileTx,
  profileId: string,
  payload: {
    playerPreferences?: { playerId: string; listType: string; magnitude: number }[] | undefined;
    teamPreferences?: { teamId: string; listType: string; magnitude: number }[] | undefined;
  },
): Promise<void> {
  if (payload.playerPreferences !== undefined) {
    await tx.preferencePlayer.deleteMany({ where: { profileId } });
    if (payload.playerPreferences.length > 0) {
      await tx.preferencePlayer.createMany({
        data: payload.playerPreferences.map((entry) => ({
          profileId,
          playerId: entry.playerId,
          listType: entry.listType as never,
          magnitude: entry.magnitude,
        })),
      });
    }
  }
  if (payload.teamPreferences !== undefined) {
    await tx.preferenceTeam.deleteMany({ where: { profileId } });
    if (payload.teamPreferences.length > 0) {
      await tx.preferenceTeam.createMany({
        data: payload.teamPreferences.map((entry) => ({
          profileId,
          teamId: entry.teamId,
          listType: entry.listType as never,
          magnitude: entry.magnitude,
        })),
      });
    }
  }
}

async function setIsDefault(tx: ProfileTx, ownerId: string, profileId: string): Promise<void> {
  await tx.preferenceProfile.updateMany({
    where: { ownerId, isDefault: true, NOT: { id: profileId } },
    data: { isDefault: false },
  });
  await tx.preferenceProfile.update({
    where: { id: profileId },
    data: { isDefault: true },
  });
}

/** Postgres-count mutation rate limit (same pattern as recommendation
 * recalculation): ≤30 preference mutations per user per rolling minute. */
export async function assertPreferenceMutationRate(userId: string): Promise<void> {
  const recent = await prisma.auditLog.count({
    where: {
      actorId: userId,
      action: { startsWith: "preference." },
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
  });
  if (recent >= 30) throw new RateLimitedError("preference change rate limit reached");
}

/** Redacted audit summary — counts only, never note text or Clerk IDs. */
export function auditSnapshot(detail: PreferenceProfileDetail): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const entry of detail.playerPreferences) {
    counts[entry.listType] = (counts[entry.listType] ?? 0) + 1;
  }
  return {
    name: detail.name,
    isDefault: detail.isDefault,
    presetKey: detail.presetKey,
    presetVersion: detail.presetVersion,
    schemaVersion: detail.schemaVersion,
    playerListCounts: counts,
    teamCount: detail.teamPreferences.length,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listProfiles(
  ownerId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ profiles: PreferenceProfileSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const rows = await prisma.preferenceProfile.findMany({
    where: { ownerId },
    select: PROFILE_SUMMARY_SELECT,
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    profiles: page.map(toSummary),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getProfile(
  ownerId: string,
  profileId: string,
): Promise<PreferenceProfileDetail | null> {
  const row = await prisma.preferenceProfile.findFirst({
    where: { id: profileId, ownerId },
    include: {
      playerPreferences: { select: { playerId: true, listType: true, magnitude: true } },
      teamPreferences: { select: { teamId: true, listType: true, magnitude: true } },
    },
  });
  return row ? toDetail(row) : null;
}

export async function getDefaultProfile(ownerId: string): Promise<PreferenceProfileSummary | null> {
  const row = await prisma.preferenceProfile.findFirst({
    where: { ownerId, isDefault: true },
    select: PROFILE_SUMMARY_SELECT,
  });
  return row ? toSummary(row) : null;
}

export async function createProfile(
  ownerId: string,
  payload: CreateProfileInput,
): Promise<PreferenceProfileDetail> {
  // Re-validate at the service boundary so direct callers (tests, future
  // jobs) get the same guarantees as HTTP clients.
  const reparsed = createProfileSchema.safeParse(payload);
  if (!reparsed.success) {
    throw new PreferenceValidationError("invalid profile payload", zodIssueMap(reparsed.error));
  }
  const resolved = resolveSettings(reparsed.data);

  const existingSameName = await prisma.preferenceProfile.findFirst({
    where: { ownerId, name: payload.name },
    select: { id: true },
  });
  if (existingSameName) {
    throw new ProfileNameConflictError(`a profile named "${payload.name}" already exists`);
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.preferenceProfile.create({
      data: {
        ownerId,
        name: payload.name,
        presetKey: resolved.presetKey,
        presetVersion: resolved.presetVersion,
        settingsJson: resolved.settings,
        isDefault: false,
      },
    });
    await writeReferenceRows(tx, row.id, payload);
    if (payload.isDefault || (await tx.preferenceProfile.count({ where: { ownerId } })) === 1) {
      await setIsDefault(tx, ownerId, row.id);
    }
    return tx.preferenceProfile.findUniqueOrThrow({
      where: { id: row.id },
      include: {
        playerPreferences: { select: { playerId: true, listType: true, magnitude: true } },
        teamPreferences: { select: { teamId: true, listType: true, magnitude: true } },
      },
    });
  });

  return toDetail(created);
}

export async function updateProfile(
  ownerId: string,
  profileId: string,
  payload: UpdateProfileInput,
): Promise<PreferenceProfileDetail> {
  const reparsed = updateProfileSchema.safeParse(payload);
  if (!reparsed.success) {
    throw new PreferenceValidationError("invalid profile payload", zodIssueMap(reparsed.error));
  }
  const validated = reparsed.data;

  const existing = await prisma.preferenceProfile.findFirst({
    where: { id: profileId, ownerId },
    select: { id: true, name: true },
  });
  if (!existing) throw new PreferenceNotFoundError();

  if (
    validated.name !== undefined &&
    validated.name !== existing.name &&
    (await prisma.preferenceProfile.findFirst({
      where: { ownerId, name: validated.name, NOT: { id: profileId } },
      select: { id: true },
    }))
  ) {
    throw new ProfileNameConflictError(`a profile named "${validated.name}" already exists`);
  }

  let resolved: ReturnType<typeof resolveSettings> | null = null;
  if (validated.settings || validated.preset) {
    resolved = resolveSettings(validated);
  }

  await validateReferenceRows(validated);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.preferenceProfile.update({
      where: { id: profileId },
      data: {
        ...(validated.name !== undefined ? { name: validated.name } : {}),
        ...(resolved
          ? {
              settingsJson: resolved.settings,
              presetKey: resolved.presetKey,
              presetVersion: resolved.presetVersion,
            }
          : {}),
      },
    });
    await writeReferenceRows(tx, profileId, validated);
    if (validated.isDefault) await setIsDefault(tx, ownerId, profileId);
    return tx.preferenceProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: {
        playerPreferences: { select: { playerId: true, listType: true, magnitude: true } },
        teamPreferences: { select: { teamId: true, listType: true, magnitude: true } },
      },
    });
  });

  return toDetail(updated);
}

export interface DeleteProfileResult {
  deletedId: string;
  promotedDefaultName: string | null;
}

/** Safe delete: cascades remove this profile's list rows only (never players,
 * teams, leagues, users, drafts, or audit history). If the deleted profile was
 * the owner's default AND other profiles remain, the most recently updated
 * remaining profile becomes default — an actionable, deterministic outcome. */
export async function deleteProfile(
  ownerId: string,
  profileId: string,
): Promise<DeleteProfileResult> {
  const wasDefault = await prisma.preferenceProfile.findFirst({
    where: { id: profileId, ownerId },
    select: { isDefault: true },
  });
  if (!wasDefault) throw new PreferenceNotFoundError();

  return prisma.$transaction(async (tx) => {
    await tx.preferenceProfile.delete({ where: { id: profileId } });
    let promotedDefaultName: string | null = null;
    if (wasDefault.isDefault) {
      const candidate = await tx.preferenceProfile.findFirst({
        where: { ownerId },
        // Creation order is stable even though default-swaps bump updatedAt.
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true },
      });
      if (candidate) {
        await setIsDefault(tx, ownerId, candidate.id);
        promotedDefaultName = candidate.name;
      }
    }
    return { deletedId: profileId, promotedDefaultName };
  });
}
