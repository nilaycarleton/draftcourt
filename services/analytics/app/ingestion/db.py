"""SQLAlchemy Core table definitions mirroring `packages/db/prisma/schema.prisma`
exactly — snake_case table names (Prisma's `@@map`), camelCase quoted
columns (Prisma never `@map`s individual fields; see
docs/adr/0005-phase1-data-model.md). This is the concrete implementation of
ADR 0002 / BUILD_SPEC.md section 3.1's "Python uses SQLAlchemy Core...
where batch access is necessary; it never creates migrations" — every
`Table` here targets a table Prisma's migrations already created, and
nothing in this module issues DDL.

Postgres enum types (`CREATE TYPE ...`) already exist from the Prisma
migration; `create_type=False` on every `ENUM` column below is what stops
SQLAlchemy from trying to (and failing to, or worse, drifting from Prisma's
definition) recreate them.
"""

from __future__ import annotations

from sqlalchemy import (
    ARRAY,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    MetaData,
    Numeric,
    String,
    Table,
    Uuid,
)
from sqlalchemy.dialects.postgresql import ENUM as PgEnum
from sqlalchemy.dialects.postgresql import JSONB

metadata = MetaData()


def _pg_enum(name: str, *values: str) -> PgEnum:
    return PgEnum(*values, name=name, create_type=False)


availability_enum = _pg_enum(
    "Availability", "ACTIVE", "INJURED", "SUSPENDED", "UNSIGNED", "RETIRED"
)
eligible_position_enum = _pg_enum("EligiblePosition", "PG", "SG", "SF", "PF", "C", "G", "F")
stat_scope_enum = _pg_enum("StatScope", "NBA", "COLLEGE", "INTERNATIONAL")
source_adapter_type_enum = _pg_enum("SourceAdapterType", "FILE", "API")
ingestion_run_status_enum = _pg_enum(
    "IngestionRunStatus", "PENDING", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"
)
raw_record_status_enum = _pg_enum(
    "RawRecordStatus", "PENDING", "VALIDATED", "QUARANTINED", "PUBLISHED"
)
identity_match_status_enum = _pg_enum("IdentityMatchStatus", "CONFIRMED", "CANDIDATE", "REJECTED")
identity_match_method_enum = _pg_enum("IdentityMatchMethod", "PROVIDER_ID", "NAME_DOB", "MANUAL")
signal_type_enum = _pg_enum(
    "SignalType", "INJURY", "TRADE", "STARTER_CHANGE", "ROLE_UP", "ROLE_DOWN"
)
override_status_enum = _pg_enum("OverrideStatus", "ACTIVE", "EXPIRED", "SUPERSEDED", "REVOKED")
projection_model_status_enum = _pg_enum(
    "ProjectionModelStatus", "DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"
)
projection_run_status_enum = _pg_enum(
    "ProjectionRunStatus", "PENDING", "RUNNING", "SUCCEEDED", "FAILED"
)

users = Table(
    "users",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("clerkUserId", String, nullable=False),
    Column("role", _pg_enum("UserRole", "USER", "ADMIN"), nullable=False),
)

nba_teams = Table(
    "nba_teams",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("nbaProviderId", String, nullable=False),
    Column("abbreviation", String, nullable=False),
    Column("name", String, nullable=False),
    Column("city", String, nullable=False),
    Column("conference", String, nullable=False),
    Column("division", String, nullable=False),
    Column("colorPrimary", String, nullable=False),
    Column("colorSecondary", String, nullable=False),
    Column("createdAt", DateTime(timezone=True), nullable=False),
    Column("updatedAt", DateTime(timezone=True), nullable=False),
)

players = Table(
    "players",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("slug", String, nullable=False),
    Column("displayName", String, nullable=False),
    Column("legalName", String, nullable=False),
    Column("dob", DateTime(timezone=True), nullable=True),
    Column("heightInches", Integer, nullable=True),
    Column("weightLbs", Integer, nullable=True),
    Column("status", availability_enum, nullable=False),
    Column("unsigned", Boolean, nullable=False),
    Column("rookie", Boolean, nullable=False),
    Column("draftYear", Integer, nullable=True),
    Column("birthCountry", String, nullable=True),
    Column("imageUrl", String, nullable=True),
    Column("currentTeamId", Uuid, ForeignKey("nba_teams.id"), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
    Column("updatedAt", DateTime(timezone=True), nullable=False),
)

player_external_identities = Table(
    "player_external_identities",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("sourceId", Uuid, ForeignKey("data_sources.id"), nullable=False),
    Column("externalId", String, nullable=False),
    Column("playerId", Uuid, ForeignKey("players.id"), nullable=True),
    Column("candidateName", String, nullable=False),
    Column("candidateDob", DateTime(timezone=True), nullable=True),
    Column("matchConfidence", Float, nullable=True),
    Column("matchMethod", identity_match_method_enum, nullable=True),
    Column("status", identity_match_status_enum, nullable=False),
    Column("reviewedById", Uuid, ForeignKey("users.id"), nullable=True),
    Column("reviewedAt", DateTime(timezone=True), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
    Column("updatedAt", DateTime(timezone=True), nullable=False),
)

player_eligibilities = Table(
    "player_eligibilities",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("playerId", Uuid, ForeignKey("players.id"), nullable=False),
    Column("season", String, nullable=False),
    Column("position", eligible_position_enum, nullable=False),
)

player_season_stats = Table(
    "player_season_stats",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("playerId", Uuid, ForeignKey("players.id"), nullable=False),
    Column("season", String, nullable=False),
    Column("scope", stat_scope_enum, nullable=False),
    Column("gamesPlayed", Integer, nullable=False),
    Column("minutesTotal", Float, nullable=False),
    Column("pts", Float, nullable=False),
    Column("reb", Float, nullable=False),
    Column("ast", Float, nullable=False),
    Column("stl", Float, nullable=False),
    Column("blk", Float, nullable=False),
    Column("tov", Float, nullable=False),
    Column("fgm", Float, nullable=False),
    Column("fga", Float, nullable=False),
    Column("ftm", Float, nullable=False),
    Column("fta", Float, nullable=False),
    Column("threePm", Float, nullable=False),
    Column("sourceId", Uuid, ForeignKey("data_sources.id"), nullable=True),
    Column("sourceRecordId", Uuid, ForeignKey("raw_source_records.id"), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
    Column("updatedAt", DateTime(timezone=True), nullable=False),
)

data_sources = Table(
    "data_sources",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("name", String, nullable=False),
    Column("adapterType", source_adapter_type_enum, nullable=False),
    Column("enabled", Boolean, nullable=False),
    Column("termsUrl", String, nullable=True),
    Column("attribution", String, nullable=False),
    Column("permittedUses", ARRAY(String), nullable=False),
    Column("rateLimitPerMinute", Integer, nullable=True),
    Column("lastComplianceReviewAt", DateTime(timezone=True), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
    Column("updatedAt", DateTime(timezone=True), nullable=False),
)

ingestion_runs = Table(
    "ingestion_runs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("sourceId", Uuid, ForeignKey("data_sources.id"), nullable=False),
    Column("jobType", String, nullable=False),
    Column("status", ingestion_run_status_enum, nullable=False),
    Column("recordsExtracted", Integer, nullable=False),
    Column("recordsValidated", Integer, nullable=False),
    Column("recordsQuarantined", Integer, nullable=False),
    Column("recordsPublished", Integer, nullable=False),
    Column("checksum", String, nullable=True),
    Column("traceId", String, nullable=False),
    Column("startedAt", DateTime(timezone=True), nullable=False),
    Column("finishedAt", DateTime(timezone=True), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
)

raw_source_records = Table(
    "raw_source_records",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("sourceId", Uuid, ForeignKey("data_sources.id"), nullable=False),
    Column("ingestionRunId", Uuid, ForeignKey("ingestion_runs.id"), nullable=False),
    Column("externalKey", String, nullable=False),
    Column("schemaVersion", String, nullable=False),
    Column("checksum", String, nullable=False),
    Column("payload", JSONB, nullable=False),
    Column("status", raw_record_status_enum, nullable=False),
    Column("validationErrors", JSONB, nullable=True),
    Column("fetchedAt", DateTime(timezone=True), nullable=False),
    Column("createdAt", DateTime(timezone=True), nullable=False),
)

player_news_signals = Table(
    "player_news_signals",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("playerId", Uuid, ForeignKey("players.id"), nullable=False),
    Column("type", signal_type_enum, nullable=False),
    Column("impact", Float, nullable=False),
    Column("confidence", Float, nullable=False),
    Column("rationale", String, nullable=True),
    Column("adminApproved", Boolean, nullable=False),
    Column("sourceId", Uuid, ForeignKey("data_sources.id"), nullable=True),
    Column("createdById", Uuid, ForeignKey("users.id"), nullable=True),
    Column("effectiveAt", DateTime(timezone=True), nullable=False),
    Column("expiresAt", DateTime(timezone=True), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
    Column("updatedAt", DateTime(timezone=True), nullable=False),
)

adp_observations = Table(
    "adp_observations",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("playerId", Uuid, ForeignKey("players.id"), nullable=False),
    Column("sourceId", Uuid, ForeignKey("data_sources.id"), nullable=False),
    Column("format", String, nullable=False),
    Column("season", String, nullable=False),
    Column("sampleSize", Integer, nullable=False),
    Column("adp", Numeric(6, 2), nullable=False),
    Column("rank", Integer, nullable=False),
    Column("capturedAt", DateTime(timezone=True), nullable=False),
)

adp_consensus_snapshots = Table(
    "adp_consensus_snapshots",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("season", String, nullable=False),
    Column("format", String, nullable=False),
    Column("methodologyVersion", String, nullable=False),
    Column("capturedAt", DateTime(timezone=True), nullable=False),
)

adp_consensus_players = Table(
    "adp_consensus_players",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("snapshotId", Uuid, ForeignKey("adp_consensus_snapshots.id"), nullable=False),
    Column("playerId", Uuid, ForeignKey("players.id"), nullable=False),
    Column("consensusAdp", Numeric(6, 2), nullable=False),
    Column("dispersion", Numeric(6, 2), nullable=False),
    Column("sourcesCount", Integer, nullable=False),
    Column("valueConfidence", Float, nullable=False),
)

projection_models = Table(
    "projection_models",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("modelKey", String, nullable=False),
    Column("version", String, nullable=False),
    Column("algorithm", String, nullable=False),
    Column("featureSchemaChecksum", String, nullable=False),
    Column("trainingWindowStartSeason", String, nullable=False),
    Column("trainingWindowEndSeason", String, nullable=False),
    Column("metrics", JSONB, nullable=True),
    Column("artifactUri", String, nullable=True),
    Column("artifactChecksum", String, nullable=True),
    Column("status", projection_model_status_enum, nullable=False),
    Column("createdAt", DateTime(timezone=True), nullable=False),
    Column("updatedAt", DateTime(timezone=True), nullable=False),
)

projection_runs = Table(
    "projection_runs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("modelId", Uuid, ForeignKey("projection_models.id"), nullable=False),
    Column("season", String, nullable=False),
    Column("dataCutoff", DateTime(timezone=True), nullable=False),
    Column("reason", String, nullable=False),
    Column("status", projection_run_status_enum, nullable=False),
    Column("isCurrent", Boolean, nullable=False),
    Column("inputChecksum", String, nullable=True),
    Column("startedAt", DateTime(timezone=True), nullable=False),
    Column("finishedAt", DateTime(timezone=True), nullable=True),
    Column("publishedAt", DateTime(timezone=True), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
)

player_projections = Table(
    "player_projections",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("runId", Uuid, ForeignKey("projection_runs.id"), nullable=False),
    Column("playerId", Uuid, ForeignKey("players.id"), nullable=False),
    Column("games", Float, nullable=False),
    Column("minutesPerGame", Float, nullable=False),
    Column("pts", Float, nullable=False),
    Column("reb", Float, nullable=False),
    Column("ast", Float, nullable=False),
    Column("stl", Float, nullable=False),
    Column("blk", Float, nullable=False),
    Column("tov", Float, nullable=False),
    Column("fgm", Float, nullable=False),
    Column("fga", Float, nullable=False),
    Column("ftm", Float, nullable=False),
    Column("fta", Float, nullable=False),
    Column("threePm", Float, nullable=False),
    Column("lower80", JSONB, nullable=False),
    Column("upper80", JSONB, nullable=False),
    Column("injuryRisk", Float, nullable=False),
    Column("consistency", Float, nullable=False),
    Column("upside", Float, nullable=False),
    Column("roleSecurity", Float, nullable=False),
    Column("overallRank", Integer, nullable=False),
    Column("fantasyPoints", Float, nullable=False),
    Column("createdAt", DateTime(timezone=True), nullable=False),
)

projection_overrides = Table(
    "projection_overrides",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("projectionRunId", Uuid, ForeignKey("projection_runs.id"), nullable=True),
    Column("adminId", Uuid, ForeignKey("users.id"), nullable=False),
    Column("playerId", Uuid, ForeignKey("players.id"), nullable=False),
    Column("season", String, nullable=False),
    Column("stat", String, nullable=False),
    Column("deltaValue", Numeric(10, 3), nullable=True),
    Column("replacementValue", Numeric(10, 3), nullable=True),
    Column("rationale", String, nullable=False),
    Column("status", override_status_enum, nullable=False),
    Column("supersedesId", Uuid, ForeignKey("projection_overrides.id"), nullable=True),
    Column("effectiveAt", DateTime(timezone=True), nullable=False),
    Column("expiresAt", DateTime(timezone=True), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
    Column("updatedAt", DateTime(timezone=True), nullable=False),
)

audit_log = Table(
    "audit_log",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("actorId", Uuid, ForeignKey("users.id"), nullable=True),
    Column("action", String, nullable=False),
    Column("entityType", String, nullable=False),
    Column("entityId", String, nullable=False),
    Column("beforeJson", JSONB, nullable=True),
    Column("afterJson", JSONB, nullable=True),
    Column("traceId", String, nullable=False),
    Column("createdAt", DateTime(timezone=True), nullable=False),
)

analytics_job_status_enum = _pg_enum(
    "AnalyticsJobStatus", "PENDING", "RUNNING", "SUCCEEDED", "FAILED", "TIMEOUT"
)

analytics_jobs = Table(
    "analytics_jobs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("kind", String, nullable=False),
    Column("status", analytics_job_status_enum, nullable=False),
    Column("idempotencyKey", String, nullable=True),
    Column("request", JSONB, nullable=True),
    Column("result", JSONB, nullable=True),
    Column("errorCode", String, nullable=True),
    Column("traceId", String, nullable=False),
    Column("startedAt", DateTime(timezone=True), nullable=False),
    Column("finishedAt", DateTime(timezone=True), nullable=True),
    Column("createdAt", DateTime(timezone=True), nullable=False),
)


__all__: list[str] = [
    "adp_consensus_players",
    "adp_consensus_snapshots",
    "adp_observations",
    "analytics_jobs",
    "audit_log",
    "data_sources",
    "ingestion_runs",
    "metadata",
    "nba_teams",
    "player_eligibilities",
    "player_external_identities",
    "player_news_signals",
    "player_projections",
    "player_season_stats",
    "players",
    "projection_models",
    "projection_overrides",
    "projection_runs",
    "raw_source_records",
    "users",
]
