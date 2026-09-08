import type { Prisma } from "@draftcourt/db";
import { prisma } from "@draftcourt/db";
import {
  cpuPersonalityByKey,
  defaultCpuPersonalityKey,
  overallPickToSlot,
  overallPickToRound,
  overallPickToPickInRound,
  parseCpuPersonalitySnapshot,
  selectCpuPick,
  toCpuPersonalitySnapshot,
  type CpuPersonalitySnapshot,
  type EngineProjection,
  type EnginePlayerMeta,
  type EngineAdpEntry,
  type EngineSettings,
} from "@draftcourt/domain";
import { PROJECTION_AS_OF } from "./current-run";
import {
  DraftError,
  DraftNotFoundError,
  DraftStatusError,
  DraftIllegalPickError,
  type AuthoritativeState,
  makePick,
  lockDraft,
  loadSnapshot,
  computeOpenSlots,
  chooseSlot,
  currentAuthoritative,
  versionConflict,
} from "./drafts";
import {
  generateDemoToken,
  hashDemoTokenAsync,
  hashRateLimitKey,
  isValidDemoTokenFormat,
  verifyDemoTokenAsync,
} from "./demo-tokens";
import { checkDemoRateLimit, DEMO_RATE_LIMITS } from "./demo-rate-limit";
import { randomBytes } from "node:crypto";

const PROJECTION_AS_OF_YEAR = PROJECTION_AS_OF.getFullYear();
const SEED_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const DEMO_CAPABILITY_COOKIE = "__Secure-demo-capability";
export const DEMO_LIFETIME_HOURS = 24;
const DEMO_LIFETIME_MS = DEMO_LIFETIME_HOURS * 60 * 60 * 1000;

// Predefined demo league configurations
export const DEMO_LEAGUE_PRESETS = {
  standard: {
    name: "Standard 12-Team Points",
    type: "POINTS" as const,
    horizon: "REDRAFT" as const,
    teamCount: 12,
    userDraftSlot: 7,
    rounds: 14,
  },
  categories: {
    name: "Standard 12-Team 9-Cat",
    type: "CATEGORIES" as const,
    horizon: "REDRAFT" as const,
    teamCount: 12,
    userDraftSlot: 7,
    rounds: 14,
  },
  dynasty: {
    name: "12-Team Dynasty",
    type: "CATEGORIES" as const,
    horizon: "DYNASTY" as const,
    teamCount: 12,
    userDraftSlot: 7,
    rounds: 16,
  },
} as const;

export type DemoLeaguePresetKey = keyof typeof DEMO_LEAGUE_PRESETS;

export interface CreateDemoDraftInput {
  presetKey: DemoLeaguePresetKey;
  userDraftSlot?: number;
  cpuPersonalityKey?: string;
  teamPersonalities?: { teamSlot: number; personalityKey: string }[];
  simulationSeed?: string;
}

export interface DemoDraftState {
  id: string;
  type: string;
  status: string;
  version: number;
  currentSequence: number;
  nextOverallPick: number;
  simulationSeed: string | null;
  teams: {
    slot: number;
    displayName: string;
    isUserTeam: boolean;
    personalityKey: string | null;
  }[];
  picksRemaining: number;
  boardSize: number;
  expiresAt: string;
  capabilityToken: string | null; // only returned on create
}

export class DemoExpiredError extends DraftError {
  constructor(public readonly expiresAt: Date) {
    super(`Demo draft expired at ${expiresAt.toISOString()}`);
  }
}

export class DemoRevokedError extends DraftError {
  constructor() {
    super("Demo draft capability has been revoked");
  }
}

export class DemoNotFoundError extends DraftError {
  constructor() {
    super("Demo draft not found");
  }
}

export class DemoCapabilityInvalidError extends DraftError {
  constructor() {
    super("Invalid or expired demo capability");
  }
}

/** Validate and resolve demo league preset into full settings. */
function resolveDemoLeaguePreset(presetKey: DemoLeaguePresetKey, userDraftSlot?: number) {
  const preset = DEMO_LEAGUE_PRESETS[presetKey];
  // Runtime validation: presetKey may be an invalid string at runtime (type narrowing doesn't guarantee runtime safety)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (preset === undefined) {
    throw new DraftIllegalPickError("Unknown demo preset");
  }

  const slot = userDraftSlot ?? preset.userDraftSlot;
  const maxSlot = preset.teamCount;
  if (slot < 1 || slot > maxSlot) {
    const maxSlotStr = String(maxSlot);
    const slotStr = String(slot);
    throw new DraftIllegalPickError(`userDraftSlot ${slotStr} out of range (1-${maxSlotStr})`);
  }

  return { ...preset, userDraftSlot: slot };
}

/** Build scoring/roster rules for a demo preset. */
function buildDemoSettingsSnapshot(preset: ReturnType<typeof resolveDemoLeaguePreset>) {
  const scoringRules =
    preset.type === "POINTS"
      ? [
          {
            stat: "PTS",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "REB",
            weight: 1.2,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "AST",
            weight: 1.5,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "STL",
            weight: 3,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "BLK",
            weight: 3,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "TOV",
            weight: -1,
            direction: "LOWER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "FG_PCT",
            weight: 0,
            direction: "HIGHER_BETTER" as const,
            enabled: false,
            punt: true,
          },
          {
            stat: "FT_PCT",
            weight: 0,
            direction: "HIGHER_BETTER" as const,
            enabled: false,
            punt: true,
          },
          {
            stat: "THREE_PM",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
        ]
      : [
          {
            stat: "PTS",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "REB",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "AST",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "STL",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "BLK",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "TOV",
            weight: -1,
            direction: "LOWER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "FG_PCT",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "FT_PCT",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
          {
            stat: "THREE_PM",
            weight: 1,
            direction: "HIGHER_BETTER" as const,
            enabled: true,
            punt: false,
          },
        ];

  const rosterSlots = [
    { position: "PG", count: 2, isStarter: true },
    { position: "SG", count: 2, isStarter: true },
    { position: "SF", count: 2, isStarter: true },
    { position: "PF", count: 1, isStarter: true },
    { position: "C", count: 1, isStarter: true },
    { position: "G", count: 0, isStarter: true },
    { position: "F", count: 0, isStarter: true },
    { position: "UTIL", count: 2, isStarter: true },
    { position: "BENCH", count: 4, isStarter: false },
  ];

  return {
    season: "2026-27",
    type: preset.type,
    horizon: preset.horizon,
    teamCount: preset.teamCount,
    rounds: preset.rounds,
    userDraftSlot: preset.userDraftSlot,
    playoffWeeks: null,
    scoringRules,
    rosterSlots,
  };
}

/** Create a new demo draft with capability token. */
export async function createDemoDraft(
  input: CreateDemoDraftInput,
  clientIp: string | null,
  clientUserAgent: string | null,
): Promise<{ draftId: string; capabilityToken: string; expiresAt: Date; state: DemoDraftState }> {
  // Rate limit demo creation
  const rateLimitKey = hashRateLimitKey(clientIp, clientUserAgent);
  const createConfig = DEMO_RATE_LIMITS.create ?? {
    windowSeconds: 3600,
    maxRequests: 3,
    keyPrefix: "demo:create",
  };
  const rl = await checkDemoRateLimit(rateLimitKey, createConfig);
  if (!rl.allowed) {
    throw new DraftStatusError("Demo creation rate limit reached");
  }

  const preset = resolveDemoLeaguePreset(input.presetKey, input.userDraftSlot);
  const settingsSnapshot = buildDemoSettingsSnapshot(preset);

  // Validate CPU personality
  const defaultKey = input.cpuPersonalityKey ?? defaultCpuPersonalityKey;
  const personalityDef = cpuPersonalityByKey(defaultKey);
  if (!personalityDef?.supportedModes.includes("DEMO")) {
    throw new DraftIllegalPickError(
      `CPU personality "${defaultKey}" not available for demo drafts`,
    );
  }

  // Validate team overrides
  const overrides = new Map<number, string>();
  const maxTeamSlot = preset.teamCount;
  for (const override of input.teamPersonalities ?? []) {
    const teamSlot = override.teamSlot;
    if (!Number.isInteger(teamSlot) || teamSlot < 1 || teamSlot > maxTeamSlot) {
      const teamSlotStr = String(teamSlot);
      throw new DraftIllegalPickError(`CPU team slot ${teamSlotStr} out of range`);
    }
    if (teamSlot === preset.userDraftSlot) {
      throw new DraftIllegalPickError("CPU personality cannot be assigned to the user's team");
    }
    if (overrides.has(teamSlot)) {
      const teamSlotStr = String(teamSlot);
      throw new DraftIllegalPickError(`Duplicate personality override for team ${teamSlotStr}`);
    }
    const def = cpuPersonalityByKey(override.personalityKey);
    if (!def?.supportedModes.includes("DEMO")) {
      throw new DraftIllegalPickError(
        `CPU personality "${override.personalityKey}" not available for demo drafts`,
      );
    }
    overrides.set(teamSlot, override.personalityKey);
  }

  // Validate seed
  const seed = input.simulationSeed ?? generateSimulationSeed();
  if (!SEED_PATTERN.test(seed)) {
    throw new DraftIllegalPickError(
      "Simulation seed must be 1-64 characters of letters, digits, or dashes",
    );
  }

  // Resolve projection run and ADP snapshot
  const [projectionRun, adpSnapshot] = await Promise.all([
    prisma.projectionRun.findFirst({
      where: { season: "2026-27", isCurrent: true },
      select: { id: true },
    }),
    prisma.adpConsensusSnapshot.findFirst({
      where: { season: "2026-27" },
      orderBy: { capturedAt: "desc" },
      select: { id: true },
    }),
  ]);

  if (!projectionRun) {
    throw new DraftStatusError("No published projection run exists for demo drafts");
  }

  // Generate capability token and hash (async, non-blocking for public creation path).
  const rawToken = generateDemoToken();
  if (!isValidDemoTokenFormat(rawToken)) {
    throw new DraftStatusError("Generated demo token failed format validation");
  }
  const tokenHash = await hashDemoTokenAsync(rawToken);
  const expiresAt = new Date(Date.now() + DEMO_LIFETIME_MS);
  const rateLimitKeyHash = hashRateLimitKey(clientIp, clientUserAgent);

  let draftId: string | undefined;
  await prisma.$transaction(async (tx) => {
    // Create draft (ownerId = NULL for demo) — active immediately for guests
    const draft = await tx.draft.create({
      data: {
        ownerId: null,
        leagueId: null, // demo drafts don't have a persistent league
        type: "DEMO",
        status: "ACTIVE",
        engineVersion: "phase3-preferences-1.0.0",
        settingsSnapshot,
        currentSequence: 0,
        nextOverallPick: 1,
        version: 0,
        simulationSeed: seed,
        projectionRunId: projectionRun.id,
        adpSnapshotId: adpSnapshot?.id ?? null,
      },
      select: { id: true },
    });
    draftId = draft.id;

    // Create demo capability
    const capability = await tx.demoDraftCapability.create({
      data: {
        draftId: draft.id,
        tokenHash,
        rateLimitKey: rateLimitKeyHash,
        expiresAt,
      },
    });

    // Link capability to draft
    await tx.draft.update({
      where: { id: draft.id },
      data: { demoCapabilityId: capability.id, demoTokenHash: tokenHash },
    });

    // Create draft teams with CPU personality snapshots
    const teamsData = Array.from({ length: preset.teamCount }, (_, index) => {
      const slot = index + 1;
      const isUserTeam = slot === preset.userDraftSlot;
      let cpuData: { cpuStrategy: string; cpuPersonalitySnapshot: Prisma.InputJsonValue } | null =
        null;

      if (!isUserTeam) {
        const key = overrides.get(slot) ?? defaultKey;
        const def = cpuPersonalityByKey(key);
        if (!def) {
          throw new DraftStatusError(`CPU personality "${key}" not found`);
        }
        const snapshot = toCpuPersonalitySnapshot(def);
        cpuData = {
          cpuStrategy: snapshot.key,
          cpuPersonalitySnapshot: snapshot as unknown as Prisma.InputJsonValue,
        };
      }

      const displayName = isUserTeam ? "Your Team" : `CPU Team ${String(slot)}`;
      return {
        draftId: draft.id,
        slot,
        displayName,
        isUserTeam,
        ...(cpuData ?? {}),
      };
    });

    await tx.draftTeam.createMany({ data: teamsData });
  });

  // Fetch state after transaction commit (outside transaction) to avoid reading uncommitted data.
  // Safe because the capability was just created with the raw token we generated.
  if (!draftId) throw new DraftStatusError("Demo creation failed: missing draft ID");
  const state = await getDemoDraftStateForCapability(draftId, rawToken);
  return { draftId, capabilityToken: rawToken, expiresAt, state };
}

/** Get demo draft state for a valid capability token. */
export async function getDemoDraftState(
  draftId: string,
  capabilityToken: string,
): Promise<DemoDraftState> {
  const capability = await prisma.demoDraftCapability.findUnique({
    where: { draftId },
    select: { tokenHash: true, expiresAt: true, revokedAt: true },
  });

  if (!capability) throw new DemoNotFoundError();
  if (capability.revokedAt) throw new DemoRevokedError();
  if (capability.expiresAt < new Date()) throw new DemoExpiredError(capability.expiresAt);

  if (!isValidDemoTokenFormat(capabilityToken)) throw new DemoCapabilityInvalidError();
  const valid = await verifyDemoTokenCapability(capabilityToken, capability.tokenHash);
  if (!valid) throw new DemoCapabilityInvalidError();

  return getDemoDraftStateForCapability(draftId, capabilityToken);
}

/** Internal: get state assuming capability is already validated. */
async function getDemoDraftStateForCapability(
  draftId: string,
  _capabilityToken: string,
): Promise<DemoDraftState> {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      type: true,
      status: true,
      version: true,
      currentSequence: true,
      nextOverallPick: true,
      simulationSeed: true,
      settingsSnapshot: true,
      teams: {
        orderBy: { slot: "asc" },
        select: {
          slot: true,
          displayName: true,
          isUserTeam: true,
          cpuPersonalitySnapshot: true,
          cpuStrategy: true,
        },
      },
    },
  });

  if (!draft) throw new DemoNotFoundError();

  // Find capability to get expiry
  const capability = await prisma.demoDraftCapability.findUnique({
    where: { draftId },
    select: { expiresAt: true },
  });

  const teams = draft.teams.map((team) => {
    let personalityKey: string | null = null;
    if (team.cpuPersonalitySnapshot !== null) {
      try {
        const parsed = parseCpuPersonalitySnapshot(team.cpuPersonalitySnapshot);
        personalityKey = parsed.key;
      } catch {
        personalityKey = team.cpuStrategy ?? null;
      }
    }
    return {
      slot: team.slot,
      displayName: team.displayName,
      isUserTeam: team.isUserTeam,
      personalityKey,
    };
  });

  const settingsSnapshot = draft.settingsSnapshot as unknown as {
    rounds: number;
    teamCount: number;
  };
  const actualBoardSize = settingsSnapshot.rounds * settingsSnapshot.teamCount;

  return {
    id: draft.id,
    type: draft.type,
    status: draft.status,
    version: draft.version,
    currentSequence: draft.currentSequence,
    nextOverallPick: draft.nextOverallPick,
    simulationSeed: draft.simulationSeed,
    teams,
    picksRemaining: actualBoardSize - (draft.nextOverallPick - 1),
    boardSize: actualBoardSize,
    expiresAt:
      capability?.expiresAt.toISOString() ?? new Date(Date.now() + DEMO_LIFETIME_MS).toISOString(),
    capabilityToken: null, // never return raw token after create
  };
}

/** Verify a raw token against a capability's stored hash (async, non-blocking). */
async function verifyDemoTokenCapability(rawToken: string, storedHash: string): Promise<boolean> {
  // Validate format before expensive work; fail closed quickly on malformed tokens.
  if (!isValidDemoTokenFormat(rawToken)) return false;
  return verifyDemoTokenAsync(rawToken, storedHash);
}

/** Generate a random simulation seed for demo drafts. */
function generateSimulationSeed(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(12);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length] ?? "0";
  return out;
}

/** Execute a guest user pick. */
export async function makeDemoUserPick(params: {
  draftId: string;
  capabilityToken: string;
  playerId: string;
  idempotencyKey: string;
  ifMatchVersion: number;
}): Promise<{
  duplicated: boolean;
  authoritative: AuthoritativeState & { playerId: string; teamSlot: number };
}> {
  const capability = await validateDemoCapability(params.draftId, params.capabilityToken);
  if (!capability) throw new DemoCapabilityInvalidError();

  return prisma.$transaction(async (tx) => {
    const draft = await lockDraft(tx, params.draftId);
    if (!draft) throw new DraftNotFoundError();
    if (draft.type !== "DEMO") throw new DraftStatusError("Not a demo draft");
    if (draft.status !== "ACTIVE")
      throw new DraftStatusError(`Demo draft not active (${draft.status})`);
    if (draft.version !== params.ifMatchVersion)
      throw await versionConflict(tx, params.draftId, draft.version);

    // Idempotency check
    const existing = await tx.draftEvent.findUnique({
      where: {
        draftId_idempotencyKey: { draftId: params.draftId, idempotencyKey: params.idempotencyKey },
      },
      select: { playerId: true, teamSlot: true, sequence: true },
    });
    if (existing) {
      return {
        duplicated: true,
        authoritative: {
          ...currentAuthoritative(draft),
          playerId: existing.playerId ?? "",
          teamSlot: existing.teamSlot ?? 0,
        },
      };
    }

    const snapshot = await loadSnapshot(tx, params.draftId);
    const boardFull = draft.nextOverallPick > snapshot.rounds * snapshot.teamCount;
    if (boardFull) throw new DraftStatusError("Draft board is complete");

    // Must be user's turn
    const draftingSlot = overallPickToSlot(draft.nextOverallPick, snapshot.teamCount);
    if (draftingSlot !== snapshot.userDraftSlot) {
      throw new DraftStatusError("It is not your turn");
    }

    // Validate player
    const player = await tx.player.findUnique({
      where: { id: params.playerId },
      select: { id: true, status: true, unsigned: true },
    });
    if (!player) throw new DraftIllegalPickError("Player not found");
    if (player.status === "RETIRED") throw new DraftIllegalPickError("Player is retired");
    if (player.status === "UNSIGNED" || player.unsigned) {
      throw new DraftIllegalPickError("Unsigned players not allowed in demo drafts");
    }

    const alreadyDrafted = await tx.draftRosterAssignment.findUnique({
      where: { draftId_playerId: { draftId: params.draftId, playerId: params.playerId } },
      select: { id: true },
    });
    if (alreadyDrafted) throw new DraftIllegalPickError("Player already drafted");

    const eligibility = await tx.playerEligibility.findMany({
      where: { playerId: params.playerId, season: snapshot.season },
      select: { position: true },
    });
    if (eligibility.length === 0)
      throw new DraftIllegalPickError("Player has no eligibility for this season");

    const openSlots = await computeOpenSlots(tx, params.draftId, draftingSlot, snapshot);
    const slotChoice = chooseSlot(
      openSlots,
      eligibility.map((e) => e.position),
    );
    if (!slotChoice) throw new DraftIllegalPickError("No legal roster slot available for player");

    const sequence = draft.currentSequence + 1;
    const eventId = crypto.randomUUID();

    await tx.draftEvent.create({
      data: {
        id: eventId,
        draftId: params.draftId,
        sequence,
        eventType: "PLAYER_DRAFTED",
        actorUserId: null, // guest has no user ID
        teamSlot: draftingSlot,
        playerId: params.playerId,
        round: overallPickToRound(draft.nextOverallPick, snapshot.teamCount),
        pickInRound: overallPickToPickInRound(draft.nextOverallPick, snapshot.teamCount),
        idempotencyKey: params.idempotencyKey,
        payload: { slotPosition: slotChoice.position, isBench: slotChoice.isBench },
      },
    });

    await tx.draftRosterAssignment.create({
      data: {
        draftId: params.draftId,
        eventId,
        teamSlot: draftingSlot,
        playerId: params.playerId,
        slotPosition: slotChoice.position as never,
        isBench: slotChoice.isBench,
        assignedAt: new Date(),
      },
    });

    await tx.draftOutbox.create({
      data: {
        draftId: params.draftId,
        kind: "RECOMMENDATION",
        sequence,
        payload: { userTeamSlot: snapshot.userDraftSlot },
      },
    });

    const updated = await tx.draft.update({
      where: { id: params.draftId },
      data: {
        currentSequence: sequence,
        nextOverallPick: draft.nextOverallPick + 1,
        version: draft.version + 1,
      },
      select: { status: true, currentSequence: true, nextOverallPick: true, version: true },
    });

    return {
      duplicated: false,
      authoritative: { ...updated, playerId: params.playerId, teamSlot: draftingSlot },
    };
  });
}

/** Execute a guest CPU pick (advance one CPU turn). */
export async function makeDemoCpuPick(params: {
  draftId: string;
  capabilityToken: string;
  idempotencyKey: string;
  ifMatchVersion: number;
}): Promise<{
  pick: {
    playerId: string;
    displayName: string;
    slotPosition: string;
    isBench: boolean;
    sequence: number;
    duplicated: boolean;
  };
  evidence: {
    personalityKey: string;
    personalityVersion: number;
    decisionChecksum: string;
    decisionInputChecksum: string;
    selectionScore: number;
    decisionSeedHex: string;
  };
  authoritative: AuthoritativeState;
}> {
  const capability = await validateDemoCapability(params.draftId, params.capabilityToken);
  if (!capability) throw new DemoCapabilityInvalidError();

  const draft = await prisma.draft.findUnique({
    where: { id: params.draftId },
    select: {
      id: true,
      type: true,
      status: true,
      version: true,
      nextOverallPick: true,
      simulationSeed: true,
      projectionRunId: true,
      adpSnapshotId: true,
      settingsSnapshot: true,
    },
  });
  if (!draft) throw new DraftNotFoundError();
  if (draft.type !== "DEMO") throw new DraftStatusError("Not a demo draft");
  if (draft.status !== "ACTIVE")
    throw new DraftStatusError(`Demo draft not active (${draft.status})`);
  if (draft.simulationSeed === null || draft.projectionRunId === null)
    throw new DraftStatusError("Demo draft missing immutable simulation inputs");

  const settings = draft.settingsSnapshot as unknown as EngineSettings;

  const pickingSlot = overallPickToSlot(draft.nextOverallPick, settings.teamCount);
  if (pickingSlot === settings.userDraftSlot) {
    throw new DraftStatusError("It is the user's turn — CPU picks not allowed now");
  }

  // Load personality for the picking team
  const team = await prisma.draftTeam.findUnique({
    where: { draftId_slot: { draftId: params.draftId, slot: pickingSlot } },
    select: { cpuPersonalitySnapshot: true },
  });
  if (!team?.cpuPersonalitySnapshot)
    throw new DraftStatusError("No CPU personality configured for this team");

  let personality: CpuPersonalitySnapshot;
  try {
    personality = parseCpuPersonalitySnapshot(team.cpuPersonalitySnapshot);
  } catch {
    throw new DraftStatusError("Stored CPU personality snapshot failed validation");
  }

  // Load selection inputs (same as cpu-mock.ts)
  const { projections, players, adp, projectionRunId, modelVersion } =
    await loadDemoSelectionInputs(settings, draft.projectionRunId, draft.adpSnapshotId);

  const simulationSeed = draft.simulationSeed;
  const fnv1a32 = (input: string) => {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };

  const pickResult = await makePick({
    draftId: params.draftId,
    ownerId: "", // dummy - not used for demo since actorUserId is null
    idempotencyKey: params.idempotencyKey,
    ifMatchVersion: params.ifMatchVersion,
    cpu: {
      personality,
      decide: (context) =>
        selectCpuPick({
          settings: {
            season: context.snapshot.season,
            type: context.snapshot.type,
            horizon: context.snapshot.horizon,
            teamCount: context.snapshot.teamCount,
            rounds: context.snapshot.rounds,
            userDraftSlot: context.snapshot.userDraftSlot,
            scoringRules: context.snapshot.scoringRules,
            rosterSlots: context.snapshot.rosterSlots,
          },
          projectionRunId,
          modelVersion,
          projections,
          players,
          adp,
          assignments: context.assignments,
          currentTeamSlot: overallPickToSlot(context.nextOverallPick, context.snapshot.teamCount),
          nextOverallPick: context.nextOverallPick,
          personality,
          draftSeed: fnv1a32(simulationSeed),
          includeUnsigned: false,
        }),
    },
  });

  // Read back the committed pick with evidence
  const committed = await prisma.draft.findUnique({
    where: { id: params.draftId },
    select: { version: true, status: true, currentSequence: true, nextOverallPick: true },
  });
  if (!committed) throw new DraftNotFoundError();

  const event = await prisma.draftEvent.findUnique({
    where: {
      draftId_idempotencyKey: { draftId: params.draftId, idempotencyKey: params.idempotencyKey },
    },
    select: { payload: true, sequence: true, playerId: true },
  });

  const payload = (event?.payload ?? {}) as {
    slotPosition?: string;
    isBench?: boolean;
    cpuEvidence?: {
      actorType?: string;
      personalityKey?: string;
      personalityVersion?: number;
      decisionInputChecksum?: string;
      decisionChecksum?: string;
      selectionScore?: number;
      decisionSeed?: string;
    };
  };

  const displayName = await prisma.player
    .findUnique({ where: { id: event?.playerId ?? "" }, select: { displayName: true } })
    .then((row) => row?.displayName ?? "Unknown player");

  return {
    pick: {
      playerId: event?.playerId ?? "",
      displayName,
      slotPosition: payload.slotPosition ?? "UTIL",
      isBench: payload.isBench ?? false,
      sequence: event?.sequence ?? 0,
      duplicated: pickResult.duplicated,
    },
    evidence: {
      personalityKey: payload.cpuEvidence?.personalityKey ?? "unknown",
      personalityVersion: payload.cpuEvidence?.personalityVersion ?? 0,
      decisionInputChecksum: payload.cpuEvidence?.decisionInputChecksum ?? "",
      decisionChecksum: payload.cpuEvidence?.decisionChecksum ?? "",
      selectionScore: payload.cpuEvidence?.selectionScore ?? 0,
      decisionSeedHex: payload.cpuEvidence?.decisionSeed ?? "",
    },
    authoritative: {
      version: committed.version,
      status: committed.status,
      currentSequence: committed.currentSequence,
      nextOverallPick: committed.nextOverallPick,
    },
  };
}

/** Validate demo capability and return it if valid (async, fails closed, non-blocking). */
async function validateDemoCapability(draftId: string, capabilityToken: string) {
  const capability = await prisma.demoDraftCapability.findUnique({
    where: { draftId },
    select: { tokenHash: true, expiresAt: true, revokedAt: true },
  });
  if (!capability) return null;
  if (capability.revokedAt) return null;
  if (capability.expiresAt < new Date()) return null;
  if (!isValidDemoTokenFormat(capabilityToken)) return null;
  if (!(await verifyDemoTokenCapability(capabilityToken, capability.tokenHash))) return null;
  return capability;
}

/** Undo the latest pick in a demo draft. */
export async function undoDemoPick(params: {
  draftId: string;
  capabilityToken: string;
  idempotencyKey: string;
  ifMatchVersion: number;
}): Promise<{ authoritative: AuthoritativeState }> {
  const capability = await validateDemoCapability(params.draftId, params.capabilityToken);
  if (!capability) throw new DemoCapabilityInvalidError();

  return prisma.$transaction(async (tx) => {
    const draft = await lockDraft(tx, params.draftId);
    if (!draft) throw new DraftNotFoundError();
    if (draft.type !== "DEMO") throw new DraftStatusError("Not a demo draft");

    const existing = await tx.draftEvent.findUnique({
      where: {
        draftId_idempotencyKey: { draftId: params.draftId, idempotencyKey: params.idempotencyKey },
      },
      select: { sequence: true, causationEventId: true },
    });
    if (existing) {
      return { authoritative: currentAuthoritative(draft) };
    }

    if (draft.status !== "ACTIVE" && draft.status !== "PAUSED") {
      throw new DraftStatusError(`undo requires ACTIVE or PAUSED (is ${draft.status})`);
    }
    if (draft.version !== params.ifMatchVersion) {
      throw await versionConflict(tx, params.draftId, draft.version);
    }

    const undoneIds = await tx.draftEvent.findMany({
      where: { draftId: params.draftId, eventType: "PICK_UNDONE" },
      select: { causationEventId: true },
    });
    const undoneSet = new Set(undoneIds.map((u) => u.causationEventId));
    const recentPicks = await tx.draftEvent.findMany({
      where: { draftId: params.draftId, eventType: "PLAYER_DRAFTED" },
      orderBy: { sequence: "desc" },
      take: 10,
      select: { id: true, playerId: true, teamSlot: true, sequence: true, payload: true },
    });
    const candidates = recentPicks.filter(
      (c) => !undoneSet.has(c.id) && (c.payload as { keeper?: boolean } | null)?.keeper !== true,
    );
    const target = candidates[0];
    if (!target) throw new DraftStatusError("no effective pick to undo");

    const sequence = draft.currentSequence + 1;
    await tx.draftEvent.create({
      data: {
        draftId: params.draftId,
        sequence,
        eventType: "PICK_UNDONE",
        actorUserId: null,
        teamSlot: target.teamSlot,
        playerId: target.playerId,
        causationEventId: target.id,
        idempotencyKey: params.idempotencyKey,
      },
    });
    if (!target.playerId) throw new DraftStatusError("corrupt pick event: missing player");
    await tx.draftRosterAssignment.delete({
      where: { draftId_playerId: { draftId: params.draftId, playerId: target.playerId } },
    });
    await tx.draftOutbox.create({
      data: { draftId: params.draftId, kind: "RECOMMENDATION", sequence },
    });
    const updated = await tx.draft.update({
      where: { id: params.draftId },
      data: {
        currentSequence: sequence,
        nextOverallPick: Math.max(1, draft.nextOverallPick - 1),
        version: draft.version + 1,
      },
      select: { status: true, currentSequence: true, nextOverallPick: true, version: true },
    });
    return { authoritative: updated };
  });
}

/** Complete a demo draft. */
export async function completeDemoDraft(params: {
  draftId: string;
  capabilityToken: string;
  idempotencyKey: string;
  ifMatchVersion: number;
}): Promise<{ authoritative: AuthoritativeState }> {
  const capability = await validateDemoCapability(params.draftId, params.capabilityToken);
  if (!capability) throw new DemoCapabilityInvalidError();

  return prisma.$transaction(async (tx) => {
    const draft = await lockDraft(tx, params.draftId);
    if (!draft) throw new DraftNotFoundError();
    if (draft.type !== "DEMO") throw new DraftStatusError("Not a demo draft");
    if (draft.status !== "ACTIVE")
      throw new DraftStatusError(`Demo draft not active (${draft.status})`);
    if (draft.version !== params.ifMatchVersion)
      throw await versionConflict(tx, params.draftId, draft.version);

    const snapshot = await loadSnapshot(tx, params.draftId);
    const boardFull = draft.nextOverallPick > snapshot.rounds * snapshot.teamCount;
    if (!boardFull) throw new DraftStatusError("Draft board is not complete");

    const sequence = draft.currentSequence + 1;
    const eventId = crypto.randomUUID();

    await tx.draftEvent.create({
      data: {
        id: eventId,
        draftId: params.draftId,
        sequence,
        eventType: "DRAFT_COMPLETED",
        actorUserId: null,
        idempotencyKey: params.idempotencyKey,
      },
    });

    const updated = await tx.draft.update({
      where: { id: params.draftId },
      data: { status: "COMPLETED", currentSequence: sequence, version: draft.version + 1 },
      select: { status: true, currentSequence: true, nextOverallPick: true, version: true },
    });

    return { authoritative: updated };
  });
}

/** Abandon a demo draft (revoke capability). */
export async function abandonDemoDraft(params: {
  draftId: string;
  capabilityToken: string;
}): Promise<void> {
  const capability = await validateDemoCapability(params.draftId, params.capabilityToken);
  if (!capability) throw new DemoCapabilityInvalidError();

  await prisma.$transaction(async (tx) => {
    await tx.demoDraftCapability.update({
      where: { draftId: params.draftId },
      data: { revokedAt: new Date() },
    });
    await tx.draft.update({
      where: { id: params.draftId },
      data: { status: "ABANDONED" },
    });
  });
}

/** Load selection inputs for demo CPU picks (mirrors cpu-mock.ts). */
async function loadDemoSelectionInputs(
  settings: EngineSettings,
  projectionRunId: string,
  adpSnapshotId: string | null,
): Promise<{
  projections: EngineProjection[];
  players: EnginePlayerMeta[];
  adp: EngineAdpEntry[] | null;
  projectionRunId: string;
  modelVersion: string;
}> {
  const [currentRun, adpEntries] = await Promise.all([
    prisma.projectionRun.findFirst({
      where: { id: projectionRunId },
      select: { id: true, model: { select: { modelKey: true, version: true } } },
    }),
    adpSnapshotId === null
      ? Promise.resolve([] as EngineAdpEntry[])
      : adpEntriesForSnapshot(adpSnapshotId),
  ]);
  if (!currentRun) throw new DraftStatusError("No published projection run for the season");

  const projections = await prisma.playerProjection.findMany({
    where: { runId: currentRun.id },
    // Explicit order (Phase 3F determinism): CPU inputs must not depend on
    // unspecified Postgres row-return order.
    orderBy: { playerId: "asc" },
    select: {
      playerId: true,
      games: true,
      minutesPerGame: true,
      pts: true,
      reb: true,
      ast: true,
      stl: true,
      blk: true,
      tov: true,
      fgm: true,
      fga: true,
      ftm: true,
      fta: true,
      threePm: true,
      lower80: true,
      upper80: true,
      injuryRisk: true,
      consistency: true,
      upside: true,
      roleSecurity: true,
    },
  });
  const projectedIds = projections.map((line) => line.playerId);
  const [players, eligibilities] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: projectedIds } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        displayName: true,
        status: true,
        unsigned: true,
        dob: true,
        currentTeamId: true,
      },
    }),
    prisma.playerEligibility.findMany({
      where: { season: settings.season, playerId: { in: projectedIds } },
      orderBy: [{ playerId: "asc" }, { position: "asc" }],
      select: { playerId: true, position: true },
    }),
  ]);

  const eligibilityByPlayer = new Map<string, string[]>();
  for (const row of eligibilities) {
    const list = eligibilityByPlayer.get(row.playerId) ?? [];
    list.push(row.position);
    eligibilityByPlayer.set(row.playerId, list);
  }

  const metaByPlayer = new Map<string, EnginePlayerMeta>();
  const projectionLines: EngineProjection[] = [];
  for (const line of projections) {
    projectionLines.push({
      playerId: line.playerId,
      games: line.games,
      minutesPerGame: line.minutesPerGame,
      pts: line.pts,
      reb: line.reb,
      ast: line.ast,
      stl: line.stl,
      blk: line.blk,
      tov: line.tov,
      fgm: line.fgm,
      fga: line.fga,
      ftm: line.ftm,
      fta: line.fta,
      threePm: line.threePm,
      lower80: (line.lower80 ?? {}) as Record<string, number>,
      upper80: (line.upper80 ?? {}) as Record<string, number>,
      injuryRisk: line.injuryRisk,
      consistency: line.consistency,
      upside: line.upside,
      roleSecurity: line.roleSecurity,
    });
    const playerRow = players.find((p) => p.id === line.playerId);
    if (!playerRow || metaByPlayer.has(line.playerId)) continue;
    const age = playerRow.dob ? PROJECTION_AS_OF_YEAR - playerRow.dob.getFullYear() : undefined;
    metaByPlayer.set(line.playerId, {
      playerId: playerRow.id,
      displayName: playerRow.displayName,
      eligiblePositions: eligibilityByPlayer.get(playerRow.id) ?? [],
      status: playerRow.unsigned ? "UNSIGNED" : playerRow.status,
      nbaTeamId: playerRow.currentTeamId ?? undefined,
      ...(age !== undefined && age > 0 && age < 60 ? { age } : {}),
    });
  }

  return {
    projections: projectionLines.filter((line) => metaByPlayer.has(line.playerId)),
    players: [...metaByPlayer.values()],
    adp: adpEntries.length > 0 ? adpEntries : null,
    projectionRunId: currentRun.id,
    modelVersion: `${currentRun.model.modelKey}@${currentRun.model.version}`,
  };
}

async function adpEntriesForSnapshot(snapshotId: string): Promise<EngineAdpEntry[]> {
  const snapshot = await prisma.adpConsensusSnapshot.findUnique({
    where: { id: snapshotId },
    select: {
      id: true,
      // Rank is assigned by position: return consensus-ADP order explicitly.
      players: {
        orderBy: [{ consensusAdp: "asc" }, { playerId: "asc" }],
        take: 400,
        select: { playerId: true, consensusAdp: true, sourcesCount: true },
      },
    },
  });
  if (!snapshot) return [];
  return snapshot.players.map((entry, index) => ({
    playerId: entry.playerId,
    adp: entry.consensusAdp.toNumber(),
    rank: index + 1,
    sourcesCount: entry.sourcesCount,
  }));
}
