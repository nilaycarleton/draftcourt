-- CreateEnum
CREATE TYPE "Availability" AS ENUM ('ACTIVE', 'INJURED', 'SUSPENDED', 'UNSIGNED', 'RETIRED');

-- CreateEnum
CREATE TYPE "EligiblePosition" AS ENUM ('PG', 'SG', 'SF', 'PF', 'C', 'G', 'F');

-- CreateEnum
CREATE TYPE "StatScope" AS ENUM ('NBA', 'COLLEGE', 'INTERNATIONAL');

-- CreateEnum
CREATE TYPE "SourceAdapterType" AS ENUM ('FILE', 'API');

-- CreateEnum
CREATE TYPE "IngestionRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "RawRecordStatus" AS ENUM ('PENDING', 'VALIDATED', 'QUARANTINED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "IdentityMatchStatus" AS ENUM ('CONFIRMED', 'CANDIDATE', 'REJECTED');

-- CreateEnum
CREATE TYPE "IdentityMatchMethod" AS ENUM ('PROVIDER_ID', 'NAME_DOB', 'MANUAL');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('INJURY', 'TRADE', 'STARTER_CHANGE', 'ROLE_UP', 'ROLE_DOWN');

-- CreateEnum
CREATE TYPE "OverrideStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ProjectionModelStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DEPRECATED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectionRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "nba_teams" (
    "id" UUID NOT NULL,
    "nbaProviderId" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "conference" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "colorPrimary" TEXT NOT NULL,
    "colorSecondary" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "nba_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "dob" TIMESTAMPTZ,
    "heightInches" INTEGER,
    "weightLbs" INTEGER,
    "status" "Availability" NOT NULL DEFAULT 'ACTIVE',
    "unsigned" BOOLEAN NOT NULL DEFAULT false,
    "rookie" BOOLEAN NOT NULL DEFAULT false,
    "draftYear" INTEGER,
    "birthCountry" TEXT,
    "imageUrl" TEXT,
    "currentTeamId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_external_identities" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "playerId" UUID,
    "candidateName" TEXT NOT NULL,
    "candidateDob" TIMESTAMPTZ,
    "matchConfidence" DOUBLE PRECISION,
    "matchMethod" "IdentityMatchMethod",
    "status" "IdentityMatchStatus" NOT NULL DEFAULT 'CANDIDATE',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "player_external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_eligibilities" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "season" TEXT NOT NULL,
    "position" "EligiblePosition" NOT NULL,

    CONSTRAINT "player_eligibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_season_stats" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "season" TEXT NOT NULL,
    "scope" "StatScope" NOT NULL,
    "gamesPlayed" INTEGER NOT NULL,
    "minutesTotal" DOUBLE PRECISION NOT NULL,
    "pts" DOUBLE PRECISION NOT NULL,
    "reb" DOUBLE PRECISION NOT NULL,
    "ast" DOUBLE PRECISION NOT NULL,
    "stl" DOUBLE PRECISION NOT NULL,
    "blk" DOUBLE PRECISION NOT NULL,
    "tov" DOUBLE PRECISION NOT NULL,
    "fgm" DOUBLE PRECISION NOT NULL,
    "fga" DOUBLE PRECISION NOT NULL,
    "ftm" DOUBLE PRECISION NOT NULL,
    "fta" DOUBLE PRECISION NOT NULL,
    "threePm" DOUBLE PRECISION NOT NULL,
    "sourceId" UUID,
    "sourceRecordId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "player_season_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "adapterType" "SourceAdapterType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "termsUrl" TEXT,
    "attribution" TEXT NOT NULL,
    "permittedUses" TEXT[],
    "rateLimitPerMinute" INTEGER,
    "lastComplianceReviewAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_runs" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "jobType" TEXT NOT NULL DEFAULT 'FULL_PIPELINE',
    "status" "IngestionRunStatus" NOT NULL DEFAULT 'PENDING',
    "recordsExtracted" INTEGER NOT NULL DEFAULT 0,
    "recordsValidated" INTEGER NOT NULL DEFAULT 0,
    "recordsQuarantined" INTEGER NOT NULL DEFAULT 0,
    "recordsPublished" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "traceId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ NOT NULL,
    "finishedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_source_records" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "ingestionRunId" UUID NOT NULL,
    "externalKey" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "RawRecordStatus" NOT NULL DEFAULT 'PENDING',
    "validationErrors" JSONB,
    "fetchedAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_news_signals" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "type" "SignalType" NOT NULL,
    "impact" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT,
    "adminApproved" BOOLEAN NOT NULL DEFAULT false,
    "sourceId" UUID,
    "createdById" UUID,
    "effectiveAt" TIMESTAMPTZ NOT NULL,
    "expiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "player_news_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adp_observations" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "adp" DECIMAL(6,2) NOT NULL,
    "rank" INTEGER NOT NULL,
    "capturedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "adp_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adp_consensus_snapshots" (
    "id" UUID NOT NULL,
    "season" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "methodologyVersion" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "adp_consensus_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adp_consensus_players" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "consensusAdp" DECIMAL(6,2) NOT NULL,
    "dispersion" DECIMAL(6,2) NOT NULL,
    "sourcesCount" INTEGER NOT NULL,
    "valueConfidence" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "adp_consensus_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projection_models" (
    "id" UUID NOT NULL,
    "modelKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "featureSchemaChecksum" TEXT NOT NULL,
    "trainingWindowStartSeason" TEXT NOT NULL,
    "trainingWindowEndSeason" TEXT NOT NULL,
    "metrics" JSONB,
    "artifactUri" TEXT,
    "artifactChecksum" TEXT,
    "status" "ProjectionModelStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "projection_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projection_runs" (
    "id" UUID NOT NULL,
    "modelId" UUID NOT NULL,
    "season" TEXT NOT NULL,
    "dataCutoff" TIMESTAMPTZ NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ProjectionRunStatus" NOT NULL DEFAULT 'PENDING',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "inputChecksum" TEXT,
    "startedAt" TIMESTAMPTZ NOT NULL,
    "finishedAt" TIMESTAMPTZ,
    "publishedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projection_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_projections" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "games" DOUBLE PRECISION NOT NULL,
    "minutesPerGame" DOUBLE PRECISION NOT NULL,
    "pts" DOUBLE PRECISION NOT NULL,
    "reb" DOUBLE PRECISION NOT NULL,
    "ast" DOUBLE PRECISION NOT NULL,
    "stl" DOUBLE PRECISION NOT NULL,
    "blk" DOUBLE PRECISION NOT NULL,
    "tov" DOUBLE PRECISION NOT NULL,
    "fgm" DOUBLE PRECISION NOT NULL,
    "fga" DOUBLE PRECISION NOT NULL,
    "ftm" DOUBLE PRECISION NOT NULL,
    "fta" DOUBLE PRECISION NOT NULL,
    "threePm" DOUBLE PRECISION NOT NULL,
    "lower80" JSONB NOT NULL,
    "upper80" JSONB NOT NULL,
    "injuryRisk" DOUBLE PRECISION NOT NULL,
    "consistency" DOUBLE PRECISION NOT NULL,
    "upside" DOUBLE PRECISION NOT NULL,
    "roleSecurity" DOUBLE PRECISION NOT NULL,
    "overallRank" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projection_overrides" (
    "id" UUID NOT NULL,
    "projectionRunId" UUID,
    "adminId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "season" TEXT NOT NULL,
    "stat" TEXT NOT NULL,
    "deltaValue" DECIMAL(10,3),
    "replacementValue" DECIMAL(10,3),
    "rationale" TEXT NOT NULL,
    "status" "OverrideStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesId" UUID,
    "effectiveAt" TIMESTAMPTZ NOT NULL,
    "expiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "projection_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nba_teams_nbaProviderId_key" ON "nba_teams"("nbaProviderId");

-- CreateIndex
CREATE UNIQUE INDEX "nba_teams_abbreviation_key" ON "nba_teams"("abbreviation");

-- CreateIndex
CREATE UNIQUE INDEX "players_slug_key" ON "players"("slug");

-- CreateIndex
CREATE INDEX "players_currentTeamId_idx" ON "players"("currentTeamId");

-- CreateIndex
CREATE INDEX "player_external_identities_status_idx" ON "player_external_identities"("status");

-- CreateIndex
CREATE UNIQUE INDEX "player_external_identities_sourceId_externalId_key" ON "player_external_identities"("sourceId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "player_eligibilities_playerId_season_position_key" ON "player_eligibilities"("playerId", "season", "position");

-- CreateIndex
CREATE INDEX "player_season_stats_playerId_season_idx" ON "player_season_stats"("playerId", "season");

-- CreateIndex
CREATE UNIQUE INDEX "player_season_stats_playerId_season_scope_key" ON "player_season_stats"("playerId", "season", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "data_sources_name_key" ON "data_sources"("name");

-- CreateIndex
CREATE INDEX "ingestion_runs_sourceId_startedAt_idx" ON "ingestion_runs"("sourceId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "raw_source_records_status_idx" ON "raw_source_records"("status");

-- CreateIndex
CREATE UNIQUE INDEX "raw_source_records_sourceId_checksum_key" ON "raw_source_records"("sourceId", "checksum");

-- CreateIndex
CREATE INDEX "player_news_signals_playerId_effectiveAt_idx" ON "player_news_signals"("playerId", "effectiveAt" DESC);

-- CreateIndex
CREATE INDEX "player_news_signals_playerId_expiresAt_idx" ON "player_news_signals"("playerId", "expiresAt");

-- CreateIndex
CREATE INDEX "adp_observations_season_format_capturedAt_playerId_idx" ON "adp_observations"("season", "format", "capturedAt" DESC, "playerId");

-- CreateIndex
CREATE INDEX "adp_consensus_snapshots_season_format_capturedAt_idx" ON "adp_consensus_snapshots"("season", "format", "capturedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "adp_consensus_players_snapshotId_playerId_key" ON "adp_consensus_players"("snapshotId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "projection_models_modelKey_version_key" ON "projection_models"("modelKey", "version");

-- CreateIndex
CREATE INDEX "projection_runs_season_isCurrent_idx" ON "projection_runs"("season", "isCurrent");

-- CreateIndex
CREATE INDEX "player_projections_runId_overallRank_idx" ON "player_projections"("runId", "overallRank");

-- CreateIndex
CREATE UNIQUE INDEX "player_projections_runId_playerId_key" ON "player_projections"("runId", "playerId");

-- CreateIndex
CREATE INDEX "projection_overrides_playerId_status_idx" ON "projection_overrides"("playerId", "status");

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_idx" ON "audit_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_actorId_createdAt_idx" ON "audit_log"("actorId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_currentTeamId_fkey" FOREIGN KEY ("currentTeamId") REFERENCES "nba_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_external_identities" ADD CONSTRAINT "player_external_identities_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_external_identities" ADD CONSTRAINT "player_external_identities_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_external_identities" ADD CONSTRAINT "player_external_identities_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_eligibilities" ADD CONSTRAINT "player_eligibilities_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_season_stats" ADD CONSTRAINT "player_season_stats_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_season_stats" ADD CONSTRAINT "player_season_stats_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_season_stats" ADD CONSTRAINT "player_season_stats_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "raw_source_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_source_records" ADD CONSTRAINT "raw_source_records_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_source_records" ADD CONSTRAINT "raw_source_records_ingestionRunId_fkey" FOREIGN KEY ("ingestionRunId") REFERENCES "ingestion_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_news_signals" ADD CONSTRAINT "player_news_signals_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_news_signals" ADD CONSTRAINT "player_news_signals_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_news_signals" ADD CONSTRAINT "player_news_signals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adp_observations" ADD CONSTRAINT "adp_observations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adp_observations" ADD CONSTRAINT "adp_observations_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adp_consensus_players" ADD CONSTRAINT "adp_consensus_players_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "adp_consensus_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adp_consensus_players" ADD CONSTRAINT "adp_consensus_players_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projection_runs" ADD CONSTRAINT "projection_runs_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "projection_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_projections" ADD CONSTRAINT "player_projections_runId_fkey" FOREIGN KEY ("runId") REFERENCES "projection_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_projections" ADD CONSTRAINT "player_projections_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projection_overrides" ADD CONSTRAINT "projection_overrides_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projection_overrides" ADD CONSTRAINT "projection_overrides_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projection_overrides" ADD CONSTRAINT "projection_overrides_projectionRunId_fkey" FOREIGN KEY ("projectionRunId") REFERENCES "projection_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projection_overrides" ADD CONSTRAINT "projection_overrides_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "projection_overrides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-added constraints Prisma's schema DSL cannot express directly — see
-- docs/adr/0005-phase1-data-model.md. Kept forward-only like every other
-- statement in this file; do not regenerate this migration from the schema.

-- Trigram name search (BUILD_SPEC.md section 4.3: "normalized display name
-- trigram/search index").
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "players_displayName_trgm_idx" ON "players" USING GIN ("displayName" gin_trgm_ops);

-- Atomic-publish pointer: at most one current run per season. This is what
-- makes ProjectionRun.isCurrent safe to flip inside a single transaction —
-- Postgres itself rejects a second row claiming isCurrent = true for a
-- season already claimed by another row.
CREATE UNIQUE INDEX "projection_runs_one_current_per_season" ON "projection_runs"("season") WHERE "isCurrent" = true;

-- Exactly one of deltaValue/replacementValue may be set, and a material
-- override always needs a non-empty rationale.
ALTER TABLE "projection_overrides" ADD CONSTRAINT "projection_overrides_value_xor_check" CHECK (num_nonnulls("deltaValue", "replacementValue") = 1);
ALTER TABLE "projection_overrides" ADD CONSTRAINT "projection_overrides_rationale_check" CHECK (length(btrim("rationale")) > 0);

-- Defense in depth: makes can never exceed attempts, even though the
-- ingestion pipeline's Pydantic validation already enforces this pre-insert.
ALTER TABLE "player_season_stats" ADD CONSTRAINT "player_season_stats_fg_check" CHECK ("fgm" <= "fga");
ALTER TABLE "player_season_stats" ADD CONSTRAINT "player_season_stats_ft_check" CHECK ("ftm" <= "fta");
