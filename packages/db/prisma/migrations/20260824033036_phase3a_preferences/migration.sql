-- CreateEnum
CREATE TYPE "PreferenceListType" AS ENUM ('FAVORITE', 'DISLIKED', 'TARGET', 'AVOID');

-- CreateEnum
CREATE TYPE "TeamPreferenceType" AS ENUM ('FAVORITE', 'DISLIKED');

-- CreateTable
CREATE TABLE "user_preference_profiles" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "presetKey" VARCHAR(64),
    "presetVersion" INTEGER,
    "settingsJson" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_preference_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preference_players" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "listType" "PreferenceListType" NOT NULL,
    "magnitude" DECIMAL(4,3) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preference_teams" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "listType" "TeamPreferenceType" NOT NULL,
    "magnitude" DECIMAL(4,3) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_player_ranks" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "leagueId" UUID,
    "playerId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "tier" INTEGER,
    "note" VARCHAR(280),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "custom_player_ranks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_preference_profiles_ownerId_updatedAt_idx" ON "user_preference_profiles"("ownerId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "user_preference_profiles_ownerId_name_key" ON "user_preference_profiles"("ownerId", "name");

-- CreateIndex
CREATE INDEX "preference_players_profileId_idx" ON "preference_players"("profileId");

-- CreateIndex
CREATE INDEX "preference_players_playerId_idx" ON "preference_players"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "preference_players_profileId_playerId_listType_key" ON "preference_players"("profileId", "playerId", "listType");

-- CreateIndex
CREATE INDEX "preference_teams_profileId_idx" ON "preference_teams"("profileId");

-- CreateIndex
CREATE INDEX "preference_teams_teamId_idx" ON "preference_teams"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "preference_teams_profileId_teamId_key" ON "preference_teams"("profileId", "teamId");

-- CreateIndex
CREATE INDEX "custom_player_ranks_ownerId_rank_idx" ON "custom_player_ranks"("ownerId", "rank");

-- CreateIndex
CREATE INDEX "custom_player_ranks_playerId_idx" ON "custom_player_ranks"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_player_ranks_ownerId_leagueId_playerId_key" ON "custom_player_ranks"("ownerId", "leagueId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_player_ranks_ownerId_leagueId_rank_key" ON "custom_player_ranks"("ownerId", "leagueId", "rank");

-- AddForeignKey
ALTER TABLE "user_preference_profiles" ADD CONSTRAINT "user_preference_profiles_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preference_players" ADD CONSTRAINT "preference_players_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "user_preference_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preference_players" ADD CONSTRAINT "preference_players_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preference_teams" ADD CONSTRAINT "preference_teams_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "user_preference_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preference_teams" ADD CONSTRAINT "preference_teams_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "nba_teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_player_ranks" ADD CONSTRAINT "custom_player_ranks_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_player_ranks" ADD CONSTRAINT "custom_player_ranks_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_player_ranks" ADD CONSTRAINT "custom_player_ranks_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Partial unique indexes: Postgres treats NULLs as distinct in composite
-- unique indexes, so (a) the at-most-one-default-profile-per-owner invariant
-- and (b) GLOBAL custom-rank uniqueness (leagueId IS NULL) for both player
-- and rank value need explicit partial indexes. League-scoped rows are fully
-- covered by the composite uniques above.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "user_preference_profiles_one_default_per_owner" ON "user_preference_profiles"("ownerId") WHERE "isDefault";
CREATE UNIQUE INDEX "custom_player_ranks_owner_player_global_key" ON "custom_player_ranks"("ownerId", "playerId") WHERE "leagueId" IS NULL;
CREATE UNIQUE INDEX "custom_player_ranks_owner_rank_global_key" ON "custom_player_ranks"("ownerId", "rank") WHERE "leagueId" IS NULL;
