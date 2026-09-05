/**
 * Immutable draft preference snapshots (Phase 3B, ADR 0012).
 *
 * A started draft captures ONE self-contained, versioned snapshot of the
 * effective strategy inside the authoritative start transaction. Later profile
 * edits can never affect it; recommendations read only this stored object.
 *
 * Determinism rules:
 * - `capturedAt` is server-supplied provenance and is EXCLUDED from the
 *   snapshot checksum and from engine math — identical strategy content always
 *   hashes identically regardless of capture time.
 * - Unordered collections are canonically sorted before hashing (the generic
 *   canonicalizer sorts object keys but preserves array order, so array-shaped
 *   collections are sorted explicitly here).
 * - `toEnginePreferences` projects a snapshot into the engine-facing input:
 *   one resolved entry per player (severity order AVOID > DISLIKED > TARGET >
 *   FAVORITE), team entries keyed by team id, and custom ranks merged with
 *   league scope overriding global scope for the same player.
 */

import { z } from "zod";
import {
  preferenceSettingsSchema,
  type AvoidMode,
  type PreferenceFactorKey,
  type PreferencePositionKey,
  type PreferenceSettings,
} from "./preferences";
import { canonicalize, checksumInput } from "./recommendation";

export const PREFERENCE_SNAPSHOT_VERSION = 1;

export const SNAPSHOT_SOURCE_KINDS = [
  "USER_DEFAULT",
  "LEAGUE_SELECTION",
  "DRAFT_OVERRIDE",
  "DRAFTCOURT_DEFAULTS",
] as const;
export type SnapshotSourceKind = (typeof SNAPSHOT_SOURCE_KINDS)[number];

export type SnapshotPlayerListType = "FAVORITE" | "DISLIKED" | "TARGET" | "AVOID";
export type SnapshotTeamPreferenceType = "FAVORITE" | "DISLIKED";

const snapshotPlayerListTypeSchema = z.enum(["FAVORITE", "DISLIKED", "TARGET", "AVOID"]);
const snapshotTeamPreferenceTypeSchema = z.enum(["FAVORITE", "DISLIKED"]);

export interface SnapshotSourceProvenance {
  kind: SnapshotSourceKind;
  /** Non-binding provenance: the snapshot is self-contained, so this id is
   * informational only and never re-read for recommendation math. */
  profileId: string | null;
  /** Safe display label captured at start (never re-read). */
  profileName: string | null;
  presetKey: string | null;
  presetVersion: number | null;
}

export interface SnapshotPlayerEntry {
  playerId: string;
  listType: SnapshotPlayerListType;
  /** Signed exactly as stored (favorites/targets positive; dislikes/avoids
   * negative); the engine projection uses absolute values with list-type sign. */
  magnitude: number;
}

export interface SnapshotTeamEntry {
  teamId: string;
  type: SnapshotTeamPreferenceType;
  magnitude: number;
}

export interface SnapshotRankEntry {
  playerId: string;
  rank: number;
}

export interface DraftPreferenceSnapshot {
  snapshotVersion: 1;
  source: SnapshotSourceProvenance;
  preferenceSchemaVersion: PreferenceSettings["schemaVersion"];
  settings: PreferenceSettings;
  playerEntries: SnapshotPlayerEntry[];
  teamEntries: SnapshotTeamEntry[];
  customRanks: { global: SnapshotRankEntry[]; league: SnapshotRankEntry[] };
  /** Server-supplied capture time. Excluded from checksum + engine math. */
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const signedMagnitude = z.number().min(-1).max(1);

const playerEntrySchema = z
  .object({
    playerId: z.string().min(1),
    listType: snapshotPlayerListTypeSchema,
    magnitude: signedMagnitude,
  })
  .superRefine((entry, ctx) => {
    const positive = entry.magnitude > 0;
    if ((entry.listType === "FAVORITE" || entry.listType === "TARGET") && !positive) {
      ctx.addIssue({
        code: "custom",
        path: ["magnitude"],
        message: `${entry.listType.toLowerCase()} magnitude must be greater than 0`,
      });
    }
    if ((entry.listType === "DISLIKED" || entry.listType === "AVOID") && !positive) {
      // Dislikes/avoids are stored negative; snapshots preserve the stored sign.
      if (entry.magnitude >= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["magnitude"],
          message: `${entry.listType.toLowerCase()} magnitude must be less than 0`,
        });
      }
    }
  });

const rankEntrySchema = z.object({
  playerId: z.string().min(1),
  rank: z.number().int().min(1),
});

export const draftPreferenceSnapshotSchema = z.object({
  snapshotVersion: z.literal(PREFERENCE_SNAPSHOT_VERSION),
  source: z.object({
    kind: z.enum(SNAPSHOT_SOURCE_KINDS),
    profileId: z.string().min(1).nullable(),
    profileName: z.string().max(80).nullable(),
    presetKey: z.string().max(64).nullable(),
    presetVersion: z.number().int().min(1).nullable(),
  }),
  preferenceSchemaVersion: preferenceSettingsSchema.shape.schemaVersion,
  settings: preferenceSettingsSchema,
  playerEntries: z.array(playerEntrySchema).max(400),
  teamEntries: z
    .array(
      z.object({
        teamId: z.string().min(1),
        type: snapshotTeamPreferenceTypeSchema,
        magnitude: signedMagnitude,
      }),
    )
    .max(32),
  customRanks: z.object({
    global: z.array(rankEntrySchema).max(500),
    league: z.array(rankEntrySchema).max(500),
  }),
  capturedAt: z.string().min(1),
});

/** Stored snapshots are re-validated on read — unknown versions or malformed
 * payloads fail closed instead of reaching the engine. */
export function parseDraftPreferenceSnapshot(json: unknown): DraftPreferenceSnapshot {
  return draftPreferenceSnapshotSchema.parse(json);
}

// ---------------------------------------------------------------------------
// Canonical checksum (content-addressed; excludes capturedAt)
// ---------------------------------------------------------------------------

function byIdThenType(
  a: { playerId?: string; teamId?: string; listType?: string },
  b: { playerId?: string; teamId?: string; listType?: string },
): number {
  const keyA = a.playerId ?? a.teamId ?? "";
  const keyB = b.playerId ?? b.teamId ?? "";
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  return (a.listType ?? "") < (b.listType ?? "")
    ? -1
    : (a.listType ?? "") > (b.listType ?? "")
      ? 1
      : 0;
}

/** Deterministic content form of the snapshot: every unordered collection is
 * sorted and `capturedAt` (and provenance labels that cannot affect math) is
 * dropped. Profile name/preset provenance are intentionally excluded — they
 * are presentation metadata; renaming a profile must not invalidate caches. */
export function canonicalSnapshotContent(
  snapshot: DraftPreferenceSnapshot,
): Record<string, unknown> {
  return {
    snapshotVersion: snapshot.snapshotVersion,
    sourceKind: snapshot.source.kind,
    preferenceSchemaVersion: snapshot.preferenceSchemaVersion,
    settings: {
      ...snapshot.settings,
      lockedFactors: [...snapshot.settings.lockedFactors].sort(),
      positionPriorities: [...snapshot.settings.positionPriorities].sort((a, b) =>
        a.position < b.position ? -1 : 1,
      ),
      categoryPriorities: [...snapshot.settings.categoryPriorities].sort((a, b) =>
        a.stat < b.stat ? -1 : 1,
      ),
      puntStats: [...snapshot.settings.puntStats].sort(),
    },
    playerEntries: [...snapshot.playerEntries].sort(byIdThenType),
    teamEntries: [...snapshot.teamEntries].sort(byIdThenType),
    customRanks: {
      global: [...snapshot.customRanks.global].sort((a, b) => (a.playerId < b.playerId ? -1 : 1)),
      league: [...snapshot.customRanks.league].sort((a, b) => (a.playerId < b.playerId ? -1 : 1)),
    },
  };
}

export function checksumPreferenceSnapshot(snapshot: DraftPreferenceSnapshot): string {
  return checksumInput(canonicalize(canonicalSnapshotContent(snapshot)));
}

// ---------------------------------------------------------------------------
// Engine-facing projection
// ---------------------------------------------------------------------------

/** Severity order for players appearing on multiple lists. */
const PLAYER_ENTRY_PRECEDENCE: Record<SnapshotPlayerListType, number> = {
  AVOID: 0,
  DISLIKED: 1,
  TARGET: 2,
  FAVORITE: 3,
};

/**
 * The immutable preference input consumed by the pure engine. Record shapes
 * keep hashing order-independent; arrays are sorted engine-side before the
 * canonical checksum.
 */
export interface EnginePreferences {
  snapshotVersion: number;
  preferenceSchemaVersion: number;
  factorWeights: Record<PreferenceFactorKey, number>;
  riskTolerance: number;
  upsidePriority: number;
  youthBias: number;
  roleMinutesPriority: number;
  schedule: { enabled: boolean; playoffWeeks: number | null };
  positionPriorities: { position: PreferencePositionKey; priority: number }[];
  categoryPriorities: { stat: string; weight: number }[];
  puntStats: string[];
  avoidMode: AvoidMode;
  playerEntries: Record<string, { listType: SnapshotPlayerListType; magnitude: number }>;
  teamEntries: Record<string, { type: SnapshotTeamPreferenceType; magnitude: number }>;
  /** Resolved ranks (league scope overrides global for the same player). */
  customRanks: Record<string, number>;
}

export function toEnginePreferences(snapshot: DraftPreferenceSnapshot): EnginePreferences {
  const resolvedPlayers: Record<string, { listType: SnapshotPlayerListType; magnitude: number }> =
    {};
  // Descending severity so the highest-severity entry (AVOID) is assigned
  // LAST and wins the overwrite for the same player.
  const ordered = [...snapshot.playerEntries].sort(
    (a, b) =>
      PLAYER_ENTRY_PRECEDENCE[b.listType] - PLAYER_ENTRY_PRECEDENCE[a.listType] ||
      (a.playerId < b.playerId ? -1 : 1),
  );
  for (const entry of ordered) {
    resolvedPlayers[entry.playerId] = { listType: entry.listType, magnitude: entry.magnitude };
  }

  const teamEntries: Record<string, { type: SnapshotTeamPreferenceType; magnitude: number }> = {};
  for (const entry of snapshot.teamEntries) {
    teamEntries[entry.teamId] = { type: entry.type, magnitude: entry.magnitude };
  }

  const customRanks: Record<string, number> = {};
  for (const entry of snapshot.customRanks.global) customRanks[entry.playerId] = entry.rank;
  for (const entry of snapshot.customRanks.league) customRanks[entry.playerId] = entry.rank;

  const s = snapshot.settings;
  return {
    snapshotVersion: snapshot.snapshotVersion,
    preferenceSchemaVersion: snapshot.preferenceSchemaVersion,
    factorWeights: { ...s.factorWeights },
    riskTolerance: s.riskTolerance,
    upsidePriority: s.upsidePriority,
    youthBias: s.youthBias,
    roleMinutesPriority: s.roleMinutesPriority,
    schedule: { ...s.schedule },
    positionPriorities: s.positionPriorities.map((p) => ({ ...p })),
    categoryPriorities: s.categoryPriorities.map((p) => ({ ...p })),
    puntStats: [...s.puntStats],
    avoidMode: s.avoidMode,
    playerEntries: resolvedPlayers,
    teamEntries,
    customRanks,
  };
}
