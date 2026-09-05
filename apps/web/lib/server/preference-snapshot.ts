import type { Prisma } from "@draftcourt/db";
import {
  checksumPreferenceSnapshot,
  defaultPreferenceSettings,
  parseDraftPreferenceSnapshot,
  preferenceSettingsSchema,
  PREFERENCE_SNAPSHOT_VERSION,
  type DraftPreferenceSnapshot,
  type EnginePreferences,
  type PreferenceSettings,
  type SnapshotSourceKind,
  toEnginePreferences,
} from "@draftcourt/domain";
import { prisma } from "@draftcourt/db";
import { z } from "zod";

/**
 * Strategy resolution and immutable snapshot construction (Phase 3B, ADR 0012).
 *
 * Override precedence:
 *   1. explicit draft override profile
 *   2. league-selected profile
 *   3. user default profile
 *   4. versioned DraftCourt defaults (no profile)
 *
 * Every profile lookup is owner-scoped — a foreign or deleted id behaves
 * exactly like a missing one (falls through to the next precedence level), so
 * there is no enumeration oracle. Stored settings JSON is re-validated on
 * read; malformed data fails closed BEFORE draft start instead of reaching
 * the engine.
 */

export class PreferenceSnapshotValidationError extends Error {}

type SnapshotTx = Prisma.TransactionClient | typeof prisma;

const PROFILE_INCLUDE = {
  playerPreferences: { select: { playerId: true, listType: true, magnitude: true } },
  teamPreferences: { select: { teamId: true, listType: true, magnitude: true } },
} satisfies Prisma.PreferenceProfileInclude;

type ProfileRow = Prisma.PreferenceProfileGetPayload<{ include: typeof PROFILE_INCLUDE }>;

/** Owner-scoped profile fetch; returns null for missing AND foreign ids. */
async function findOwnedProfile(
  tx: SnapshotTx,
  ownerId: string,
  profileId: string,
): Promise<ProfileRow | null> {
  return tx.preferenceProfile.findFirst({
    where: { id: profileId, ownerId },
    include: PROFILE_INCLUDE,
  });
}

function parseStoredSettingsOrThrow(json: Prisma.JsonValue): PreferenceSettings {
  const parsed = preferenceSettingsSchema.safeParse(json);
  if (!parsed.success) {
    throw new PreferenceSnapshotValidationError(
      "stored preference settings failed validation — fix or reselect the profile before starting",
    );
  }
  return parsed.data;
}

interface ResolutionOutcome {
  profile: ProfileRow | null;
  kind: SnapshotSourceKind;
}

/** Applies the precedence chain. Foreign/deleted ids fall through to the next
 * precedence level rather than failing (they were owner-validated when set;
 * deletion normally clears them via SetNull before this point anyway). */
async function resolveProfile(
  tx: SnapshotTx,
  ownerId: string,
  args: { leaguePreferredProfileId: string | null; overrideProfileId: string | null },
): Promise<ResolutionOutcome> {
  if (args.overrideProfileId) {
    const profile = await findOwnedProfile(tx, ownerId, args.overrideProfileId);
    if (profile) return { profile, kind: "DRAFT_OVERRIDE" };
  }
  if (args.leaguePreferredProfileId) {
    const profile = await findOwnedProfile(tx, ownerId, args.leaguePreferredProfileId);
    if (profile) return { profile, kind: "LEAGUE_SELECTION" };
  }
  const defaults = await tx.preferenceProfile.findFirst({
    where: { ownerId, isDefault: true },
    include: PROFILE_INCLUDE,
  });
  if (defaults) return { profile: defaults, kind: "USER_DEFAULT" };
  return { profile: null, kind: "DRAFTCOURT_DEFAULTS" };
}

async function loadRanks(
  tx: SnapshotTx,
  ownerId: string,
  leagueId: string | null,
): Promise<{
  global: { playerId: string; rank: number }[];
  league: { playerId: string; rank: number }[];
}> {
  const rows = await tx.customPlayerRank.findMany({
    where: { ownerId, OR: [{ leagueId: null }, ...(leagueId ? [{ leagueId }] : [])] },
    select: { playerId: true, rank: true, leagueId: true },
    orderBy: { rank: "asc" },
  });
  const global: { playerId: string; rank: number }[] = [];
  const league: { playerId: string; rank: number }[] = [];
  for (const row of rows) {
    if (row.leagueId === null) global.push({ playerId: row.playerId, rank: row.rank });
    else league.push({ playerId: row.playerId, rank: row.rank });
  }
  return { global, league };
}

function buildSnapshot(
  outcome: ResolutionOutcome,
  globalRanks: { playerId: string; rank: number }[],
  leagueRanks: { playerId: string; rank: number }[],
): { snapshot: DraftPreferenceSnapshot; checksum: string } {
  const settings = outcome.profile
    ? parseStoredSettingsOrThrow(outcome.profile.settingsJson)
    : defaultPreferenceSettings();

  const snapshot: DraftPreferenceSnapshot = {
    snapshotVersion: PREFERENCE_SNAPSHOT_VERSION,
    source: {
      kind: outcome.kind,
      profileId: outcome.profile?.id ?? null,
      profileName: outcome.profile?.name ?? null,
      presetKey: outcome.profile?.presetKey ?? null,
      presetVersion: outcome.profile?.presetVersion ?? null,
    },
    preferenceSchemaVersion: settings.schemaVersion,
    settings,
    playerEntries:
      outcome.profile?.playerPreferences.map((entry) => ({
        playerId: entry.playerId,
        listType: entry.listType,
        magnitude: Number(entry.magnitude),
      })) ?? [],
    teamEntries:
      outcome.profile?.teamPreferences.map((entry) => ({
        teamId: entry.teamId,
        type: entry.listType,
        magnitude: Number(entry.magnitude),
      })) ?? [],
    customRanks: { global: globalRanks, league: leagueRanks },
    capturedAt: new Date().toISOString(),
  };

  return { snapshot, checksum: checksumPreferenceSnapshot(snapshot) };
}

/**
 * Builds the snapshot to persist at draft start. Runs INSIDE the caller's
 * transaction so the DRAFT_STARTED event and the snapshot commit atomically.
 */
export async function buildSnapshotForStart(
  tx: SnapshotTx,
  args: {
    ownerId: string;
    leagueId: string;
    leaguePreferredProfileId: string | null;
    overrideProfileId: string | null;
  },
): Promise<{ snapshot: DraftPreferenceSnapshot; checksum: string }> {
  const outcome = await resolveProfile(tx, args.ownerId, {
    leaguePreferredProfileId: args.leaguePreferredProfileId,
    overrideProfileId: args.overrideProfileId,
  });
  const ranks = await loadRanks(tx, args.ownerId, args.leagueId);
  return buildSnapshot(outcome, ranks.global, ranks.league);
}

// ---------------------------------------------------------------------------
// Read-only preview (leagues + pre-start drafts)
// ---------------------------------------------------------------------------

export interface StrategyPreviewView {
  kind: SnapshotSourceKind;
  profileId: string | null;
  profileName: string | null;
  presetKey: string | null;
  presetVersion: number | null;
  /** Checksum over strategy content (capturedAt-independent). */
  checksum: string;
  settingsSummary: {
    topFactors: { key: string; weight: number }[];
    punts: string[];
    avoidMode: "EXCLUDE" | "SEVERE_PENALTY";
    scheduleEnabled: boolean;
    favoritePlayers: number;
    dislikedPlayers: number;
    targetPlayers: number;
    avoidedPlayers: number;
    teamPreferences: number;
    customRanks: number;
  };
}

const TOP_FACTOR_COUNT = 4;

/** Read-only resolved-strategy preview for leagues and pre-start overrides.
 * Never persists anything. */
export async function previewResolvedStrategy(
  ownerId: string,
  args: {
    leaguePreferredProfileId: string | null;
    overrideProfileId?: string | null;
    leagueId?: string | null;
  },
): Promise<StrategyPreviewView> {
  const outcome = await resolveProfile(prisma, ownerId, {
    leaguePreferredProfileId: args.leaguePreferredProfileId,
    overrideProfileId: args.overrideProfileId ?? null,
  });
  const ranks = await loadRanks(prisma, ownerId, args.leagueId ?? null);
  const { snapshot, checksum } = buildSnapshot(outcome, ranks.global, ranks.league);

  const topFactors = Object.entries(snapshot.settings.factorWeights)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_FACTOR_COUNT)
    .map(([key, weight]) => ({ key, weight }));

  const counts: Record<"FAVORITE" | "DISLIKED" | "TARGET" | "AVOID", number> = {
    FAVORITE: 0,
    DISLIKED: 0,
    TARGET: 0,
    AVOID: 0,
  };
  for (const entry of snapshot.playerEntries) counts[entry.listType] += 1;

  return {
    kind: snapshot.source.kind,
    profileId: snapshot.source.profileId,
    profileName: snapshot.source.profileName,
    presetKey: snapshot.source.presetKey,
    presetVersion: snapshot.source.presetVersion,
    checksum,
    settingsSummary: {
      topFactors,
      punts: [...snapshot.settings.puntStats].sort(),
      avoidMode: snapshot.settings.avoidMode,
      scheduleEnabled: snapshot.settings.schedule.enabled,
      favoritePlayers: counts.FAVORITE,
      dislikedPlayers: counts.DISLIKED,
      targetPlayers: counts.TARGET,
      avoidedPlayers: counts.AVOID,
      teamPreferences: snapshot.teamEntries.length,
      customRanks: snapshot.customRanks.league.length + snapshot.customRanks.global.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Stored-snapshot reads for orchestration / evidence views
// ---------------------------------------------------------------------------

export interface DraftStrategyEvidence {
  snapshot: DraftPreferenceSnapshot;
  checksum: string;
  enginePreferences: EnginePreferences;
}

/** Parses the stored snapshot off a started draft. Returns null when the draft
 * predates Phase 3B (legacy behavior preserved). Throws on malformed payloads
 * — recommendations must be unavailable rather than silently recomputed
 * against the wrong strategy. */
export function readStoredSnapshot(json: unknown): DraftStrategyEvidence | null {
  if (json === null || json === undefined) return null;
  const parsed = z.unknown().safeParse(json);
  if (!parsed.success) {
    throw new PreferenceSnapshotValidationError("stored snapshot is not valid JSON");
  }
  let snapshot: DraftPreferenceSnapshot;
  try {
    snapshot = parseDraftPreferenceSnapshot(parsed.data);
  } catch {
    throw new PreferenceSnapshotValidationError(
      "stored draft preference snapshot failed validation",
    );
  }
  return {
    snapshot,
    checksum: checksumPreferenceSnapshot(snapshot),
    enginePreferences: toEnginePreferences(snapshot),
  };
}
