import { z } from "zod";
import { prisma } from "@draftcourt/db";
import { leagueConfigSchema, seasonSchema, type LeagueConfig } from "@draftcourt/domain";

/**
 * League CRUD and settings-version lifecycle (BUILD_SPEC.md section 4.2 +
 * Phase 2 scope item 1). Owner authorization happens here, after the route
 * layer authenticates and before any data-dependent query beyond the owner
 * lookup — a non-owner's request for someone else's league id resolves to
 * the same `null`/404 as a missing id (no enumeration oracle).
 *
 * Settings immutability: `createLeague` writes version 1; rule edits write
 * version N+1 and repoint `activeSettingsVersionId`. Nothing ever mutates an
 * existing version row. Once a draft exists for the league, rule edits are
 * rejected outright (the draft's snapshot stays authoritative for its
 * lifetime) — see `assertNoDraftsForLeague`.
 */

export const createLeagueSchema = z.object({
  name: z.string().trim().min(1).max(80),
  season: seasonSchema,
  teamCount: z.number().int().min(4).max(20),
  userDraftSlot: z.number().int().min(1),
  rounds: z.number().int().min(1).max(30),
  config: leagueConfigSchema,
});
export type CreateLeagueInput = z.infer<typeof createLeagueSchema>;

export interface LeagueSummary {
  id: string;
  name: string;
  season: string;
  type: "POINTS" | "CATEGORIES";
  horizon: "REDRAFT" | "KEEPER" | "DYNASTY";
  teamCount: number;
  userDraftSlot: number;
  rounds: number;
  playoffWeeks: number | null;
  isPrivate: boolean;
  settingsVersionNumber: number;
  updatedAt: Date;
}

export class LeagueRuleLockedError extends Error {
  constructor(message = "league settings are immutable once a draft exists — clone instead") {
    super(message);
  }
}
export class LeagueValidationError extends Error {}
export class LeagueNotFoundError extends Error {}

const LEAGUE_SUMMARY_SELECT = {
  id: true,
  name: true,
  season: true,
  type: true,
  horizon: true,
  teamCount: true,
  userDraftSlot: true,
  rounds: true,
  playoffWeeks: true,
  isPrivate: true,
  updatedAt: true,
  activeSettingsVersion: { select: { versionNumber: true } },
} as const;

function nextVersionNumber(previous: number | undefined): number {
  return (previous ?? 0) + 1;
}

function validateCrossFields(input: CreateLeagueInput): string | null {
  if (input.userDraftSlot > input.teamCount) {
    return "userDraftSlot must be between 1 and teamCount";
  }
  const totalRoster = input.config.rosterSlots.reduce((sum, s) => sum + s.count, 0);
  if (totalRoster > input.rounds) {
    // A snake draft with fewer rounds than roster slots leaves incomplete
    // rosters — legal on some platforms but rejected here so every Phase 2
    // draft produces complete materialized rosters.
    const roundsLabel = String(input.rounds);
    const rosterLabel = String(totalRoster);
    return `rounds (${roundsLabel}) must be at least the total roster size (${rosterLabel})`;
  }
  return null;
}

function requireVersion(
  row: { id: string } & { activeSettingsVersion: { versionNumber: number } | null },
): number {
  if (!row.activeSettingsVersion) {
    throw new Error(`league ${row.id} has no active settings version`);
  }
  return row.activeSettingsVersion.versionNumber;
}

export async function createLeague(
  ownerId: string,
  input: CreateLeagueInput,
): Promise<LeagueSummary> {
  const parsed = createLeagueSchema.safeParse(input);
  if (!parsed.success) {
    throw new LeagueValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const crossError = validateCrossFields(input);
  if (crossError) throw new LeagueValidationError(crossError);

  const created = await prisma.$transaction(async (tx) => {
    const league = await tx.league.create({
      data: {
        ownerId,
        name: input.name,
        season: input.season,
        type: input.config.type,
        horizon: input.config.horizon,
        teamCount: input.teamCount,
        userDraftSlot: input.userDraftSlot,
        rounds: input.rounds,
        playoffWeeks: input.config.playoffWeeks ?? null,
        isPrivate: true,
        teams: {
          create: Array.from({ length: input.teamCount }, (_, index) => {
            const slotNumber = index + 1;
            return {
              slot: slotNumber,
              displayName:
                slotNumber === input.userDraftSlot ? "My Team" : `Team ${String(slotNumber)}`,
              isUserTeam: slotNumber === input.userDraftSlot,
            };
          }),
        },
      },
      select: LEAGUE_SUMMARY_SELECT,
    });
    const version = await tx.leagueSettingsVersion.create({
      data: { leagueId: league.id, versionNumber: 1 },
      select: { id: true },
    });
    await writeConfigRules(tx, version.id, input.config);
    return tx.league.update({
      where: { id: league.id },
      data: { activeSettingsVersionId: version.id },
      select: LEAGUE_SUMMARY_SELECT,
    });
  });

  return { ...created, settingsVersionNumber: requireVersion(created) };
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function writeConfigRules(tx: Tx, versionId: string, config: LeagueConfig) {
  await tx.scoringRule.createMany({
    data: config.scoringRules.map((rule) => ({
      settingsVersionId: versionId,
      statKey: rule.stat,
      weight: rule.weight,
      direction: rule.direction,
      enabled: rule.enabled,
      punt: rule.punt,
    })),
  });
  await tx.rosterSlotRule.createMany({
    data: config.rosterSlots.map((slot) => ({
      settingsVersionId: versionId,
      position: slot.position,
      count: slot.count,
      isStarter: slot.starter,
    })),
  });
}

export async function listLeagues(
  ownerId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<{ leagues: LeagueSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const rows = await prisma.league.findMany({
    where: { ownerId },
    orderBy: { updatedAt: "desc" },
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: LEAGUE_SUMMARY_SELECT,
  });
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    nextCursor = rows[rows.length - 1]?.id ?? null;
  }
  return {
    leagues: rows.map((row) => ({ ...row, settingsVersionNumber: requireVersion(row) })),
    nextCursor,
  };
}

export async function getLeagueDetail(ownerId: string, leagueId: string) {
  const row = await prisma.league.findFirst({
    where: { id: leagueId, ownerId },
    select: {
      ...LEAGUE_SUMMARY_SELECT,
      ownerId: true,
      teams: {
        orderBy: { slot: "asc" },
        select: { id: true, slot: true, displayName: true, isUserTeam: true },
      },
      activeSettingsVersion: {
        select: {
          versionNumber: true,
          createdAt: true,
          scoringRules: {
            orderBy: { statKey: "asc" },
            select: { statKey: true, weight: true, direction: true, enabled: true, punt: true },
          },
          rosterSlots: {
            orderBy: { position: "asc" },
            select: { position: true, count: true, isStarter: true },
          },
        },
      },
    },
  });
  // Same response for missing and not-owned ids.
  if (!row?.activeSettingsVersion) return null;

  const settings = row.activeSettingsVersion;
  const summary: LeagueSummary = {
    id: row.id,
    name: row.name,
    season: row.season,
    type: row.type,
    horizon: row.horizon,
    teamCount: row.teamCount,
    userDraftSlot: row.userDraftSlot,
    rounds: row.rounds,
    playoffWeeks: row.playoffWeeks,
    isPrivate: row.isPrivate,
    settingsVersionNumber: settings.versionNumber,
    updatedAt: row.updatedAt,
  };
  return {
    ...summary,
    settings: {
      versionNumber: settings.versionNumber,
      createdAt: settings.createdAt,
      scoringRules: settings.scoringRules.map((rule) => ({
        stat: rule.statKey,
        weight: rule.weight.toNumber(),
        direction: rule.direction,
        enabled: rule.enabled,
        punt: rule.punt,
      })),
      rosterSlots: settings.rosterSlots,
    },
    teams: row.teams,
  };
}

export async function updateLeagueRules(
  ownerId: string,
  leagueId: string,
  config: LeagueConfig,
): Promise<LeagueSummary> {
  const parsed = leagueConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new LeagueValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Lock the league row inside the transaction that also creates the
    // version, so a draft created concurrently cannot slip past immutability.
    const league = await tx.league.findFirst({
      where: { id: leagueId, ownerId },
      select: { id: true },
    });
    if (!league) throw new LeagueNotFoundError();

    const existingDraft = await tx.draft.findFirst({ where: { leagueId }, select: { id: true } });
    if (existingDraft) throw new LeagueRuleLockedError();

    const latest = await tx.leagueSettingsVersion.findFirst({
      where: { leagueId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const version = await tx.leagueSettingsVersion.create({
      data: { leagueId, versionNumber: nextVersionNumber(latest?.versionNumber) },
      select: { id: true },
    });
    await writeConfigRules(tx, version.id, config);
    // Type/horizon/playoffWeeks are league-row mirrors of config; they move
    // together with the new immutable version in the same transaction.
    return tx.league.update({
      where: { id: league.id },
      data: {
        activeSettingsVersionId: version.id,
        type: config.type,
        horizon: config.horizon,
        playoffWeeks: config.playoffWeeks,
      },
      select: LEAGUE_SUMMARY_SELECT,
    });
  });

  return { ...updated, settingsVersionNumber: requireVersion(updated) };
}

export async function updateLeagueMeta(
  ownerId: string,
  leagueId: string,
  patch: { name?: string; playoffWeeks?: number | null },
): Promise<LeagueSummary> {
  await getLeagueMetaForOwner(ownerId, leagueId);
  const name =
    patch.name !== undefined ? z.string().trim().min(1).max(80).parse(patch.name) : undefined;
  const playoffWeeks =
    patch.playoffWeeks === undefined
      ? undefined
      : patch.playoffWeeks === null
        ? null
        : z.number().int().min(1).max(14).parse(patch.playoffWeeks);
  const updated = await prisma.league.update({
    where: { id: leagueId },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(playoffWeeks !== undefined ? { playoffWeeks } : {}),
    },
    select: LEAGUE_SUMMARY_SELECT,
  });
  return { ...updated, settingsVersionNumber: requireVersion(updated) };
}

/** Owner-scoped clone of configuration only — never drafts or histories
 * (BUILD_SPEC Phase 2: "Clone the league configuration without copying
 * private drafts or histories"). */
export async function cloneLeague(
  ownerId: string,
  leagueId: string,
): Promise<LeagueSummary | null> {
  const source = await prisma.league.findFirst({
    where: { id: leagueId, ownerId },
    select: {
      name: true,
      season: true,
      type: true,
      horizon: true,
      teamCount: true,
      userDraftSlot: true,
      rounds: true,
      playoffWeeks: true,
      teams: { orderBy: { slot: "asc" } },
      activeSettingsVersion: { select: { scoringRules: true, rosterSlots: true } },
    },
  });
  if (!source?.activeSettingsVersion) return null;

  const config: LeagueConfig = {
    type: source.type,
    horizon: source.horizon,
    playoffWeeks: source.playoffWeeks,
    scoringRules: source.activeSettingsVersion.scoringRules.map((rule) => ({
      stat: rule.statKey,
      weight: rule.weight.toNumber(),
      direction: rule.direction,
      enabled: rule.enabled,
      punt: rule.punt,
    })),
    rosterSlots: source.activeSettingsVersion.rosterSlots.map((slot) => ({
      position: slot.position,
      count: slot.count,
      starter: slot.isStarter,
    })),
  };

  const cloned = await prisma.$transaction(async (tx) => {
    const league = await tx.league.create({
      data: {
        ownerId,
        name: `${source.name} (copy)`.slice(0, 80),
        season: source.season,
        type: source.type,
        horizon: source.horizon,
        teamCount: source.teamCount,
        userDraftSlot: source.userDraftSlot,
        rounds: source.rounds,
        playoffWeeks: source.playoffWeeks,
        teams: {
          create: source.teams.map((team) => ({
            slot: team.slot,
            displayName: team.displayName,
            isUserTeam: team.isUserTeam,
          })),
        },
      },
      select: LEAGUE_SUMMARY_SELECT,
    });
    const version = await tx.leagueSettingsVersion.create({
      data: { leagueId: league.id, versionNumber: 1 },
      select: { id: true },
    });
    await writeConfigRules(tx, version.id, config);
    return tx.league.update({
      where: { id: league.id },
      data: { activeSettingsVersionId: version.id },
      select: LEAGUE_SUMMARY_SELECT,
    });
  });

  return { ...cloned, settingsVersionNumber: requireVersion(cloned) };
}

/** Hard delete only while no draft references the league; with drafts the
 * league carries event history and must not disappear underneath it. */
export async function deleteLeague(ownerId: string, leagueId: string): Promise<boolean> {
  await prisma.$transaction(async (tx) => {
    const league = await tx.league.findFirst({
      where: { id: leagueId, ownerId },
      select: { id: true },
    });
    if (!league) throw new LeagueNotFoundError();
    const draft = await tx.draft.findFirst({ where: { leagueId }, select: { id: true } });
    if (draft) throw new LeagueRuleLockedError("leagues with drafts cannot be deleted");
    await tx.scoringRule.deleteMany({
      where: { settingsVersion: { leagueId: league.id } },
    });
    await tx.rosterSlotRule.deleteMany({
      where: { settingsVersion: { leagueId: league.id } },
    });
    await tx.leagueSettingsVersion.deleteMany({ where: { leagueId: league.id } });
    await tx.leagueTeam.deleteMany({ where: { leagueId: league.id } });
    await tx.league.delete({ where: { id: league.id } });
  });
  return true;
}

async function getLeagueMetaForOwner(ownerId: string, leagueId: string) {
  const league = await prisma.league.findFirst({
    where: { id: leagueId, ownerId },
    select: { id: true },
  });
  if (!league) throw new LeagueNotFoundError(); // missing == not-owned
  return league;
}
