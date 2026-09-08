import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@draftcourt/db";
import { actorOf as replayActorOf, describeReplayEvent } from "@draftcourt/domain";
import { writeAuditLog } from "./audit-log";
import { newTraceId } from "@/lib/api/envelope";
import { verifyReplayIntegrity } from "./drafts";

/**
 * Private result-sharing capabilities (ADR 0016 R4–R6, Phase 3E2 M4–M6).
 *
 * - Raw token: 32 CSPRNG bytes (256-bit) → base64url 43 chars. Returned
 *   exactly once at creation; never stored, logged, audited, or cached.
 * - Stored digest: lowercase hex SHA-256 of the raw token. 256-bit input
 *   entropy makes rainbow tables infeasible; comparison is constant-time.
 * - One active row per draft (`draftId UNIQUE`); rotation bumps `version`
 *   and replaces the digest (old links die immediately).
 * - 90-day TTL (ADR 0016 R5 — BUILD_SPEC defines no share TTL); enforced
 *   server-side on every lookup. `revokedAt` invalidates immediately.
 * - Public lookup never touches Clerk and reveals exactly one COMPLETED
 *   non-DEMO result in redacted form. Invalid/revoked/expired all resolve
 *   to null (no oracle) with identical work shape.
 */

export const SHARE_TOKEN_BYTES = 32;
export const SHARE_TOKEN_BASE64URL_LENGTH = 43;
export const SHARE_TOKEN_DIGEST_LENGTH = 64;
/** 90 days in milliseconds (ADR 0016 R5). */
export const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const BASE64URL_REGEX = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_REGEX = /^[0-9a-f]{64}$/;

export class ShareNotFoundError extends Error {}
export class ShareNotReadyError extends Error {}
export class ShareValidationError extends Error {}

export function isValidShareTokenFormat(token: string): boolean {
  return BASE64URL_REGEX.test(token);
}

export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** One-way digest of a raw token. Throws on malformed input (fail closed). */
export function digestShareToken(token: string): string {
  if (!isValidShareTokenFormat(token)) throw new ShareValidationError("invalid share token format");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time verification of a raw token against a stored digest. */
export function verifyShareToken(token: string, storedDigest: string): boolean {
  try {
    if (!isValidShareTokenFormat(token)) return false;
    if (!DIGEST_REGEX.test(storedDigest)) return false;
    const candidate = createHash("sha256").update(token, "utf8").digest();
    const expected = Buffer.from(storedDigest, "hex");
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export interface ShareCreation {
  /** Raw token — return to the owner exactly once, then drop. */
  token: string;
  sharePath: string;
  expiresAt: Date;
  version: number;
  rotated: boolean;
}

function shareTtlExpiry(now: Date): Date {
  return new Date(now.getTime() + SHARE_TTL_MS);
}

/**
 * Creates or safely rotates the share capability for an owned COMPLETED
 * draft. Concurrent creators get a single documented winner: the `draftId`
 * UNIQUE guard serializes inserts; `P2002` losers rotate the winner's row.
 */
export async function createOrRotateShareForOwner(
  draftId: string,
  ownerId: string,
): Promise<ShareCreation> {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    select: { id: true, ownerId: true, status: true, type: true },
  });
  if (!draft) throw new ShareNotFoundError("draft not found");
  if (draft.type === "DEMO") throw new ShareValidationError("demo drafts cannot be shared");
  if (draft.status !== "COMPLETED") {
    throw new ShareNotReadyError(`draft must be COMPLETED (is ${draft.status})`);
  }

  const token = generateShareToken();
  const digest = digestShareToken(token);
  const expiresAt = shareTtlExpiry(new Date());
  const traceId = newTraceId();

  const existing = await prisma.draftShareCapability.findUnique({ where: { draftId } });
  if (existing) {
    const updated = await prisma.draftShareCapability.update({
      where: { draftId },
      data: {
        tokenDigest: digest,
        version: existing.version + 1,
        expiresAt,
        revokedAt: null,
        lastAccessedAt: null,
      },
      select: { version: true, expiresAt: true },
    });
    // Redacted audit: never the token or digest.
    await writeAuditLog({
      actorId: ownerId,
      action: "share.rotated",
      entityType: "draft_share",
      entityId: draftId,
      before: null,
      after: { version: updated.version, expiresAt: updated.expiresAt.toISOString() },
      traceId,
    }).catch(() => undefined);
    return {
      token,
      sharePath: `/share/${token}`,
      expiresAt: updated.expiresAt,
      version: updated.version,
      rotated: true,
    };
  }

  try {
    const created = await prisma.draftShareCapability.create({
      data: { draftId, tokenDigest: digest, version: 1, expiresAt },
      select: { version: true, expiresAt: true },
    });
    await writeAuditLog({
      actorId: ownerId,
      action: "share.created",
      entityType: "draft_share",
      entityId: draftId,
      before: null,
      after: { version: created.version, expiresAt: created.expiresAt.toISOString() },
      traceId,
    }).catch(() => undefined);
    return {
      token,
      sharePath: `/share/${token}`,
      expiresAt: created.expiresAt,
      version: created.version,
      rotated: false,
    };
  } catch (error) {
    // Concurrent winner: rotate instead of failing (documented single-winner).
    if (error instanceof Error && (error as { code?: string }).code === "P2002") {
      const winner = await prisma.draftShareCapability.findUnique({ where: { draftId } });
      if (!winner) throw error;
      const updated = await prisma.draftShareCapability.update({
        where: { draftId },
        data: {
          tokenDigest: digest,
          version: winner.version + 1,
          expiresAt,
          revokedAt: null,
          lastAccessedAt: null,
        },
        select: { version: true, expiresAt: true },
      });
      await writeAuditLog({
        actorId: ownerId,
        action: "share.rotated",
        entityType: "draft_share",
        entityId: draftId,
        before: null,
        after: { version: updated.version, expiresAt: updated.expiresAt.toISOString() },
        traceId,
      }).catch(() => undefined);
      return {
        token,
        sharePath: `/share/${token}`,
        expiresAt: updated.expiresAt,
        version: updated.version,
        rotated: true,
      };
    }
    throw error;
  }
}

/** Idempotent revocation: second revoke is still 200 with `revoked:false`. */
export async function revokeShareForOwner(
  draftId: string,
  ownerId: string,
): Promise<{ revoked: boolean }> {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    select: { id: true },
  });
  if (!draft) throw new ShareNotFoundError("draft not found");

  const existing = await prisma.draftShareCapability.findUnique({ where: { draftId } });
  if (existing?.revokedAt !== null) return { revoked: false };

  await prisma.draftShareCapability.update({
    where: { draftId },
    data: { revokedAt: new Date() },
  });
  await writeAuditLog({
    actorId: ownerId,
    action: "share.revoked",
    entityType: "draft_share",
    entityId: draftId,
    before: null,
    after: { version: existing.version },
    traceId: newTraceId(),
  }).catch(() => undefined);
  return { revoked: true };
}

// ---------------------------------------------------------------------------
// Public redacted read model (ADR 0016 R6)
// ---------------------------------------------------------------------------

export interface SharedBoardPick {
  overallPick: number;
  round: number;
  pickInRound: number;
  teamSlot: number;
  teamName: string;
  playerName: string;
  slotPosition: string | null;
  isKeeper: boolean;
}

export interface SharedTimelineEntry {
  sequence: number;
  eventType: string;
  actorType: "USER" | "CPU" | "SYSTEM";
  description: string;
  teamSlot: number | null;
  teamName: string | null;
  playerName: string | null;
  round: number | null;
  pickInRound: number | null;
  overallPick: number | null;
  causationLinked: boolean;
  /** Sequence of the undo event that compensates this pick, if any. Lets
   * read-only replay hide undone picks without exposing internal event ids. */
  undoneAtSequence: number | null;
}

export interface SharedResultDto {
  title: string;
  season: string;
  leagueType: string;
  horizon: string;
  teamCount: number;
  rounds: number;
  /** Slot whose roster the analysis grades (display name in `analyzedTeamName`).
   * The only identity signal: no emails, Clerk IDs, owner IDs, or user flags. */
  analyzedSlot: number;
  analyzedTeamName: string;
  teams: { slot: number; displayName: string }[];
  board: SharedBoardPick[];
  rosters: {
    teamSlot: number;
    teamName: string;
    players: { playerName: string; slotPosition: string | null; overallPick: number }[];
  }[];
  analysis: {
    available: boolean;
    grade?: string;
    gradeScore?: number;
    gradeComponents?: unknown;
    roundByRound?: unknown;
    categoryStrengths?: unknown;
    positionStrengths?: unknown;
    projectedStanding?: unknown;
    dataFreshness?: unknown;
    assumptions?: unknown;
    analysisVersion?: string;
    inputChecksumTruncated?: string;
    disclosure: string;
    baselineNote: string;
  };
  timeline: SharedTimelineEntry[];
  integrity: { ok: boolean; detail: string };
  generatedAt: string;
}

const SHARED_DISCLOSURE =
  "This analysis is a projection, not a guarantee — it is based on pre-season projections and market data vs a replacement-built opponent and does not predict real standings.";
const SHARED_BASELINE_NOTE =
  "Opponent baseline is synthetic (replacement-built), not real opponent rosters.";

/** Redacted freshness: status/confidence/dates only — run/snapshot UUIDs and
 * full checksums stay server-side. */
function redactFreshness(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pick = (key: string): unknown =>
    typeof record[key] === "string" ? record[key] : undefined;
  return {
    ...(typeof record.status === "string" ? { status: record.status } : { status: "LOW" }),
    ...(typeof record.confidence === "string" ? { confidence: record.confidence } : {}),
    ...(pick("generatedAt") !== undefined ? { generatedAt: pick("generatedAt") } : {}),
    ...(pick("engineVersion") !== undefined ? { engineVersion: pick("engineVersion") } : {}),
    ...(pick("analysisVersion") !== undefined ? { analysisVersion: pick("analysisVersion") } : {}),
    ...(pick("projectionPublishedAt") !== undefined
      ? { projectionPublishedAt: pick("projectionPublishedAt") }
      : {}),
    ...(pick("adpCapturedAt") !== undefined ? { adpCapturedAt: pick("adpCapturedAt") } : {}),
  };
}

/** Redacted round rows: display names + numbers only — internal player UUIDs removed. */
function redactRoundRows(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? [];
  return value.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of [
      "round",
      "overallPick",
      "pickInRound",
      "displayName",
      "slotPosition",
      "isBench",
      "isKeeper",
      "adp",
      "adpValueNorm",
      "adpDelta",
      "valueAboveReplacement",
      "isBestValue",
      "isBiggestReach",
      "isIllegal",
    ]) {
      if (record[key] !== undefined) out[key] = record[key];
    }
    return out;
  });
}

/**
 * Token-authorized public lookup. Returns the redacted DTO or null when the
 * token is invalid, revoked, expired, or the draft is not an eligible
 * COMPLETED non-DEMO draft. Never throws for untrusted input (fail closed).
 */
export async function lookupSharedResult(token: string): Promise<SharedResultDto | null> {
  if (!isValidShareTokenFormat(token)) return null;
  const digest = createHash("sha256").update(token, "utf8").digest("hex");

  // Single query: digest + revocation + expiry enforced together. The digest
  // comparison itself is exact-match (index); constant-time semantics apply
  // to the verifyShareToken path used by tests and rotation guards.
  const row = await prisma.draftShareCapability
    .findFirst({
      where: { tokenDigest: digest, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, draftId: true },
    })
    .catch(() => null);
  if (!row) return null;

  const draft = await prisma.draft
    .findUnique({
      where: { id: row.draftId },
      select: {
        id: true,
        status: true,
        type: true,
        settingsSnapshot: true,
        teams: { orderBy: { slot: "asc" }, select: { slot: true, displayName: true } },
        assignments: {
          orderBy: [{ teamSlot: "asc" }],
          select: {
            teamSlot: true,
            playerId: true,
            slotPosition: true,
            isBench: true,
            isKeeper: true,
            eventId: true,
          },
        },
        analyses: { orderBy: { generatedAt: "desc" }, take: 1 },
      },
    })
    .catch(() => null);
  if (draft?.status !== "COMPLETED" || draft.type === "DEMO") return null;

  const snapshot = draft.settingsSnapshot as unknown as {
    season?: string;
    type?: string;
    horizon?: string;
    teamCount?: number;
    rounds?: number;
    userDraftSlot?: number;
  };
  const teamCount =
    typeof snapshot.teamCount === "number" ? snapshot.teamCount : draft.teams.length;
  const rounds = typeof snapshot.rounds === "number" ? snapshot.rounds : 0;
  const season = typeof snapshot.season === "string" ? snapshot.season : "2026–27";
  const leagueType = typeof snapshot.type === "string" ? snapshot.type : "POINTS";
  const horizon = typeof snapshot.horizon === "string" ? snapshot.horizon : "REDRAFT";
  const analyzedSlot = typeof snapshot.userDraftSlot === "number" ? snapshot.userDraftSlot : 1;

  const playerIds = [...new Set(draft.assignments.map((a) => a.playerId))];
  const players = playerIds.length
    ? await prisma.player
        .findMany({
          where: { id: { in: playerIds } },
          select: { id: true, displayName: true },
        })
        .catch(() => [])
    : [];
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));
  const teamNameBySlot = new Map(draft.teams.map((t) => [t.slot, t.displayName]));

  const events = await prisma.draftEvent
    .findMany({
      where: { draftId: draft.id },
      orderBy: { sequence: "asc" },
      select: {
        id: true,
        sequence: true,
        eventType: true,
        teamSlot: true,
        playerId: true,
        round: true,
        pickInRound: true,
        causationEventId: true,
        payload: true,
      },
    })
    .catch(() => []);

  // Board + rosters from the authoritative assignment view (final state).
  const eventRoundByPlayer = new Map<string, { round: number; pickInRound: number }>();
  for (const event of events) {
    if (
      event.eventType === "PLAYER_DRAFTED" &&
      event.playerId &&
      event.round !== null &&
      event.pickInRound !== null
    ) {
      if (!eventRoundByPlayer.has(event.playerId)) {
        eventRoundByPlayer.set(event.playerId, {
          round: event.round,
          pickInRound: event.pickInRound,
        });
      }
    }
  }
  const board: SharedBoardPick[] = draft.assignments
    .map((a) => {
      const rp = eventRoundByPlayer.get(a.playerId);
      const round = rp?.round ?? 1;
      const pickInRound = rp?.pickInRound ?? 1;
      return {
        overallPick: (round - 1) * Math.max(teamCount, 1) + pickInRound,
        round,
        pickInRound,
        teamSlot: a.teamSlot,
        teamName: teamNameBySlot.get(a.teamSlot) ?? `Team ${String(a.teamSlot)}`,
        playerName: nameById.get(a.playerId) ?? "Unknown player",
        slotPosition: a.slotPosition,
        isKeeper: a.isKeeper,
      };
    })
    .sort((a, b) => a.overallPick - b.overallPick);

  const rosters = draft.teams.map((team) => ({
    teamSlot: team.slot,
    teamName: team.displayName,
    players: board
      .filter((p) => p.teamSlot === team.slot)
      .map((p) => ({
        playerName: p.playerName,
        slotPosition: p.slotPosition,
        overallPick: p.overallPick,
      })),
  }));

  // Redacted replay timeline: display names only, no internal ids.
  // Map each undo's causation target to its sequence so clients can hide
  // undone picks using sequences alone.
  const undoneAtByTargetId = new Map<string, number>();
  for (const event of events) {
    if (event.eventType === "PICK_UNDONE" && event.causationEventId) {
      undoneAtByTargetId.set(event.causationEventId, event.sequence);
    }
  }
  const sequenceById = new Map<string, number>();
  for (const event of events) sequenceById.set(event.id, event.sequence);
  const undoneAtByPickSequence = new Map<number, number>();
  for (const [targetId, undoneAt] of undoneAtByTargetId) {
    const targetSeq = sequenceById.get(targetId);
    if (targetSeq !== undefined) undoneAtByPickSequence.set(targetSeq, undoneAt);
  }
  const timeline: SharedTimelineEntry[] = events.map((event) => {
    const payload = event.payload as { slotPosition?: unknown } | null;
    const actorType = replayActorOf({ eventType: event.eventType, payload: event.payload });
    const overallPick =
      event.round !== null && event.pickInRound !== null
        ? (event.round - 1) * Math.max(teamCount, 1) + event.pickInRound
        : null;
    const teamName = event.teamSlot !== null ? (teamNameBySlot.get(event.teamSlot) ?? null) : null;
    const playerName = event.playerId ? (nameById.get(event.playerId) ?? null) : null;
    const base = describeReplayEvent(
      {
        sequence: event.sequence,
        eventType: event.eventType,
        eventId: `seq-${String(event.sequence)}`,
        causationEventId: event.causationEventId,
        teamSlot: event.teamSlot,
        playerId: event.playerId,
        slotPosition: typeof payload?.slotPosition === "string" ? payload.slotPosition : null,
        isBench: false,
        isKeeper: false,
        payload: event.payload,
      },
      Math.max(teamCount, 1),
      overallPick ?? undefined,
    );
    const description =
      playerName !== null && event.eventType === "PLAYER_DRAFTED"
        ? `${base} — ${playerName}`
        : base;
    const entry: SharedTimelineEntry = {
      sequence: event.sequence,
      eventType: event.eventType,
      actorType,
      description,
      teamSlot: event.teamSlot,
      teamName,
      playerName,
      round: event.round,
      pickInRound: event.pickInRound,
      overallPick,
      causationLinked: event.causationEventId !== null,
      undoneAtSequence: undoneAtByPickSequence.get(event.sequence) ?? null,
    };
    return entry;
  });

  const analysisRow = draft.analyses[0] as unknown as
    | {
        grade: string;
        gradeScore: number;
        gradeComponents: unknown;
        roundByRound: unknown;
        categoryStrengths: unknown;
        positionStrengths: unknown;
        projectedStanding: unknown;
        dataFreshness: unknown;
        assumptions: unknown;
        analysisVersion: string;
        inputChecksum: string;
      }
    | undefined;

  const integrity = await verifyReplayIntegrity(draft.id).catch(() => ({
    ok: false as const,
    detail: "integrity check unavailable",
  }));

  // Best-effort access marker (privacy-safe timestamp only, no IP/UA).
  void prisma.draftShareCapability
    .update({ where: { id: row.id }, data: { lastAccessedAt: new Date() } })
    .catch(() => undefined);

  return {
    title: `Draft results · ${season} · ${String(teamCount)} teams × ${String(rounds)} rounds`,
    season,
    leagueType,
    horizon,
    teamCount,
    rounds,
    analyzedSlot,
    analyzedTeamName: teamNameBySlot.get(analyzedSlot) ?? `Team ${String(analyzedSlot)}`,
    teams: draft.teams.map((t) => ({ slot: t.slot, displayName: t.displayName })),
    board,
    rosters,
    analysis:
      analysisRow === undefined
        ? { available: false, disclosure: SHARED_DISCLOSURE, baselineNote: SHARED_BASELINE_NOTE }
        : {
            available: true,
            grade: analysisRow.grade,
            gradeScore: analysisRow.gradeScore,
            gradeComponents: analysisRow.gradeComponents,
            roundByRound: redactRoundRows(analysisRow.roundByRound),
            categoryStrengths: analysisRow.categoryStrengths,
            positionStrengths: analysisRow.positionStrengths,
            projectedStanding: analysisRow.projectedStanding,
            dataFreshness: redactFreshness(analysisRow.dataFreshness),
            assumptions: analysisRow.assumptions,
            analysisVersion: analysisRow.analysisVersion,
            inputChecksumTruncated: analysisRow.inputChecksum.slice(0, 12),
            disclosure: SHARED_DISCLOSURE,
            baselineNote: SHARED_BASELINE_NOTE,
          },
    timeline,
    integrity,
    generatedAt: new Date().toISOString(),
  };
}
