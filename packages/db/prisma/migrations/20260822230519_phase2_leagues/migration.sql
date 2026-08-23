-- CreateEnum
CREATE TYPE "LeagueType" AS ENUM ('POINTS', 'CATEGORIES');

-- CreateEnum
CREATE TYPE "LeagueHorizon" AS ENUM ('REDRAFT', 'KEEPER', 'DYNASTY');

-- CreateEnum
CREATE TYPE "RosterPosition" AS ENUM ('PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BENCH');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('HIGHER_BETTER', 'LOWER_BETTER');

-- CreateTable
CREATE TABLE "leagues" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "type" "LeagueType" NOT NULL,
    "horizon" "LeagueHorizon" NOT NULL DEFAULT 'REDRAFT',
    "teamCount" INTEGER NOT NULL,
    "userDraftSlot" INTEGER NOT NULL,
    "rounds" INTEGER NOT NULL,
    "playoffWeeks" INTEGER,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "activeSettingsVersionId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "leagues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "league_settings_versions" (
    "id" UUID NOT NULL,
    "leagueId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "league_settings_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "league_teams" (
    "id" UUID NOT NULL,
    "leagueId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "isUserTeam" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "league_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_slot_rules" (
    "id" UUID NOT NULL,
    "settingsVersionId" UUID NOT NULL,
    "position" "RosterPosition" NOT NULL,
    "count" INTEGER NOT NULL,
    "isStarter" BOOLEAN NOT NULL,

    CONSTRAINT "roster_slot_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring_rules" (
    "id" UUID NOT NULL,
    "settingsVersionId" UUID NOT NULL,
    "statKey" TEXT NOT NULL,
    "weight" DECIMAL(10,3) NOT NULL,
    "direction" "Direction" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "punt" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "scoring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leagues_activeSettingsVersionId_key" ON "leagues"("activeSettingsVersionId");

-- CreateIndex
CREATE INDEX "leagues_ownerId_updatedAt_idx" ON "leagues"("ownerId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "league_settings_versions_leagueId_idx" ON "league_settings_versions"("leagueId");

-- CreateIndex
CREATE UNIQUE INDEX "league_settings_versions_leagueId_versionNumber_key" ON "league_settings_versions"("leagueId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "league_teams_leagueId_slot_key" ON "league_teams"("leagueId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "roster_slot_rules_settingsVersionId_position_key" ON "roster_slot_rules"("settingsVersionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "scoring_rules_settingsVersionId_statKey_key" ON "scoring_rules"("settingsVersionId", "statKey");

-- AddForeignKey
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_activeSettingsVersionId_fkey" FOREIGN KEY ("activeSettingsVersionId") REFERENCES "league_settings_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "league_settings_versions" ADD CONSTRAINT "league_settings_versions_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "league_teams" ADD CONSTRAINT "league_teams_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_slot_rules" ADD CONSTRAINT "roster_slot_rules_settingsVersionId_fkey" FOREIGN KEY ("settingsVersionId") REFERENCES "league_settings_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_settingsVersionId_fkey" FOREIGN KEY ("settingsVersionId") REFERENCES "league_settings_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added constraints (Prisma schema DSL cannot express CHECKs — same
-- pattern as ADR 0005): league-level invariants the service layer also
-- enforces, so a bypassed API still cannot persist impossible state.
ALTER TABLE "leagues" ADD CONSTRAINT leagues_team_count_check CHECK ("teamCount" BETWEEN 4 AND 20);
ALTER TABLE "leagues" ADD CONSTRAINT leagues_user_draft_slot_check CHECK ("userDraftSlot" >= 1 AND "userDraftSlot" <= "teamCount");
ALTER TABLE "leagues" ADD CONSTRAINT leagues_rounds_check CHECK ("rounds" BETWEEN 1 AND 30);
ALTER TABLE "leagues" ADD CONSTRAINT leagues_playoff_weeks_check CHECK ("playoffWeeks" IS NULL OR ("playoffWeeks" >= 1 AND "playoffWeeks" <= 14));
ALTER TABLE "league_teams" ADD CONSTRAINT league_teams_slot_check CHECK ("slot" >= 1);
ALTER TABLE "roster_slot_rules" ADD CONSTRAINT roster_slot_rules_count_check CHECK ("count" >= 0);
ALTER TABLE "scoring_rules" ADD CONSTRAINT scoring_rules_weight_nonnegative_check CHECK ("weight" BETWEEN -1000 AND 1000);
