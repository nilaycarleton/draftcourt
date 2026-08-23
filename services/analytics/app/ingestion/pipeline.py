"""Ingestion pipeline orchestration, per BUILD_SPEC.md section 7.2:
`extract -> quarantine -> validate -> normalize -> reconcile identities ->
publish`, wrapped in one `IngestionRun` row with counts/timings/status/
trace ID and structured logs. Adapter-agnostic — everything here operates
on `app.ingestion.base.RawRecord`/`SourceAdapter`, so swapping the demo
file adapter for a live one later touches nothing in this module.

Idempotent by construction: raw records dedup on `(sourceId, checksum)`,
and normalized entities are looked up/updated by stable identity
(`PlayerExternalIdentity`, `NbaTeam.nbaProviderId`) rather than blindly
inserted — re-running against unchanged input produces zero new raw
records and no duplicate normalized rows.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from app.ingestion import db
from app.ingestion.base import RawRecord, SourceAdapter
from app.ingestion.checksum import checksum_of, checksum_of_many
from app.ingestion.identity import ExistingPlayer, resolve_by_name_dob
from app.ingestion.retry import call_with_retry
from app.ingestion.schemas import RAW_RECORD_SCHEMAS

logger = logging.getLogger(__name__)

CURRENT_SEASON = "2026-27"
DEMO_ADMIN_CLERK_USER_ID = "user_demo_phase0_admin"

_MIN_SOURCES_FOR_TRIM = 3
_MIN_SOURCES_FOR_CONFIDENCE = 2


@dataclass
class IngestionRunResult:
    run_id: str
    trace_id: str
    status: str
    records_extracted: int = 0
    records_validated: int = 0
    records_quarantined: int = 0
    records_published: int = 0
    unresolved_identities: int = 0
    checksum: str | None = None


def _slugify(display_name: str) -> str:
    normalized = unicodedata.normalize("NFKD", display_name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    return slug or "player"


async def _get_or_create_source(conn: AsyncConnection, name: str, values: dict[str, Any]) -> str:
    existing = (
        await conn.execute(select(db.data_sources.c.id).where(db.data_sources.c.name == name))
    ).scalar_one_or_none()
    if existing is not None:
        return str(existing)
    new_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
    now = datetime.now()
    await conn.execute(
        db.data_sources.insert().values(
            id=new_id, name=name, createdAt=now, updatedAt=now, **values
        )
    )
    return new_id


@dataclass
class _ValidatedBucket:
    teams: list[dict[str, Any]] = field(default_factory=list)
    players: list[dict[str, Any]] = field(default_factory=list)
    season_stats: list[dict[str, Any]] = field(default_factory=list)
    adp_observations: list[dict[str, Any]] = field(default_factory=list)
    news_signals: list[dict[str, Any]] = field(default_factory=list)
    override_seeds: list[dict[str, Any]] = field(default_factory=list)


async def run_ingestion(conn: AsyncConnection, adapter: SourceAdapter) -> IngestionRunResult:
    """Runs the full pipeline against `adapter` on an existing connection —
    caller controls transaction boundaries (see `app.ingestion.cli` for the
    real entrypoint, which wraps this in `engine.begin()`)."""
    trace_id = str(uuid.uuid4())
    started_at = datetime.now()
    config = adapter.config

    source_id = await _get_or_create_source(
        conn,
        config.name,
        {
            "adapterType": config.adapter_type,
            "enabled": True,
            "termsUrl": config.terms_url,
            "attribution": config.attribution,
            "permittedUses": list(config.permitted_uses),
            "rateLimitPerMinute": config.rate_limit_per_minute,
            "lastComplianceReviewAt": config.last_compliance_review_at,
        },
    )

    run_id = str(uuid.uuid4())
    await conn.execute(
        db.ingestion_runs.insert().values(
            id=run_id,
            sourceId=source_id,
            jobType="FULL_PIPELINE",
            status="RUNNING",
            recordsExtracted=0,
            recordsValidated=0,
            recordsQuarantined=0,
            recordsPublished=0,
            traceId=trace_id,
            startedAt=started_at,
            createdAt=started_at,
        )
    )

    logger.info("ingestion_run_started", extra={"trace_id": trace_id, "run_id": run_id})

    records: list[RawRecord] = call_with_retry(lambda: list(adapter.extract()))
    bucket = _ValidatedBucket()
    all_checksums: list[str] = []
    quarantined = 0
    validated = 0

    for record in records:
        checksum = checksum_of(record.payload)
        all_checksums.append(checksum)

        already_seen = (
            await conn.execute(
                select(db.raw_source_records.c.id).where(
                    db.raw_source_records.c.sourceId == source_id,
                    db.raw_source_records.c.checksum == checksum,
                )
            )
        ).scalar_one_or_none()
        if already_seen is not None:
            # Idempotent reprocessing: identical payload already ingested.
            continue

        schema = RAW_RECORD_SCHEMAS.get(record.record_type)
        validation_errors: list[dict[str, Any]] | None = None
        status = "VALIDATED"
        if schema is None:
            validation_errors = [{"error": f"unknown record_type {record.record_type!r}"}]
            status = "QUARANTINED"
        else:
            try:
                parsed = schema.model_validate(record.payload)
            except ValidationError as error:
                # `.errors()` can embed the raised exception object itself
                # (e.g. inside `ctx`) for a @model_validator's `ValueError`,
                # which is not JSON-serializable. `.json()` is Pydantic's
                # own JSON-safe rendering (it stringifies ctx/exceptions),
                # so round-trip through that instead of `.errors()` directly.
                validation_errors = json.loads(error.json(include_url=False))
                status = "QUARANTINED"

        raw_id = str(uuid.uuid4())
        await conn.execute(
            db.raw_source_records.insert().values(
                id=raw_id,
                sourceId=source_id,
                ingestionRunId=run_id,
                externalKey=record.external_key,
                schemaVersion=record.schema_version,
                checksum=checksum,
                payload=record.payload,
                status=status,
                validationErrors=validation_errors,
                fetchedAt=record.fetched_at,
                createdAt=datetime.now(),
            )
        )

        if status == "QUARANTINED":
            quarantined += 1
            logger.warning(
                "record_quarantined",
                extra={
                    "trace_id": trace_id,
                    "record_type": record.record_type,
                    "external_key": record.external_key,
                    "errors": validation_errors,
                },
            )
            continue

        validated += 1
        payload = parsed.model_dump(by_alias=True)
        payload["_rawId"] = raw_id
        getattr(bucket, _BUCKET_ATTR[record.record_type]).append(payload)

    published = await _normalize_and_publish(conn, source_id, bucket)

    finished_at = datetime.now()
    aggregate_checksum = checksum_of_many(all_checksums) if all_checksums else None
    await conn.execute(
        db.ingestion_runs.update()
        .where(db.ingestion_runs.c.id == run_id)
        .values(
            status="SUCCEEDED",
            recordsExtracted=len(records),
            recordsValidated=validated,
            recordsQuarantined=quarantined,
            recordsPublished=published.records_published,
            checksum=aggregate_checksum,
            finishedAt=finished_at,
        )
    )

    logger.info(
        "ingestion_run_finished",
        extra={
            "trace_id": trace_id,
            "run_id": run_id,
            "extracted": len(records),
            "validated": validated,
            "quarantined": quarantined,
            "published": published.records_published,
            "unresolved_identities": published.unresolved_identities,
        },
    )

    return IngestionRunResult(
        run_id=run_id,
        trace_id=trace_id,
        status="SUCCEEDED",
        records_extracted=len(records),
        records_validated=validated,
        records_quarantined=quarantined,
        records_published=published.records_published,
        unresolved_identities=published.unresolved_identities,
        checksum=aggregate_checksum,
    )


_BUCKET_ATTR: dict[str, str] = {
    "team": "teams",
    "player": "players",
    "season_stat": "season_stats",
    "adp_observation": "adp_observations",
    "news_signal": "news_signals",
    "projection_override_seed": "override_seeds",
}


@dataclass
class _PublishResult:
    records_published: int = 0
    unresolved_identities: int = 0


async def _normalize_and_publish(
    conn: AsyncConnection, source_id: str, bucket: _ValidatedBucket
) -> _PublishResult:
    result = _PublishResult()
    now = datetime.now()

    team_id_by_key = await _publish_teams(conn, bucket.teams, now, result)
    player_id_by_key = await _publish_players(
        conn, source_id, bucket.players, team_id_by_key, now=now, result=result
    )
    await _publish_season_stats(
        conn, source_id, bucket.season_stats, player_id_by_key, now=now, result=result
    )
    await _publish_adp(conn, bucket.adp_observations, player_id_by_key, now, result)
    await _publish_news_signals(
        conn, source_id, bucket.news_signals, player_id_by_key, now=now, result=result
    )
    await _publish_override_seeds(conn, bucket.override_seeds, player_id_by_key, now, result)

    return result


async def _publish_teams(
    conn: AsyncConnection, teams: list[dict[str, Any]], now: datetime, result: _PublishResult
) -> dict[str, str]:
    team_id_by_key: dict[str, str] = {}
    for team in teams:
        team_id = await _upsert_team(conn, team, now)
        team_id_by_key[team["externalKey"]] = team_id
        await _mark_published(conn, team["_rawId"])
        result.records_published += 1
    return team_id_by_key


async def _publish_players(
    conn: AsyncConnection,
    source_id: str,
    players: list[dict[str, Any]],
    team_id_by_key: dict[str, str],
    *,
    now: datetime,
    result: _PublishResult,
) -> dict[str, str]:
    player_id_by_key: dict[str, str] = {}
    created_this_run: set[str] = set()
    for player in players:
        player_id, unresolved = await _reconcile_and_publish_player(
            conn,
            source_id,
            player,
            team_id_by_key,
            now,
            created_this_run=frozenset(created_this_run),
        )
        if unresolved:
            result.unresolved_identities += 1
            continue
        assert player_id is not None
        created_this_run.add(player_id)
        player_id_by_key[player["externalKey"]] = player_id
        await _publish_eligibility(conn, player_id, player["positions"])
        await _mark_published(conn, player["_rawId"])
        result.records_published += 1
    return player_id_by_key


async def _publish_season_stats(
    conn: AsyncConnection,
    source_id: str,
    season_stats: list[dict[str, Any]],
    player_id_by_key: dict[str, str],
    *,
    now: datetime,
    result: _PublishResult,
) -> None:
    for stat in season_stats:
        player_id = player_id_by_key.get(stat["playerExternalKey"])
        if player_id is None:
            continue  # player identity unresolved this run; stat stays VALIDATED, not PUBLISHED
        await _upsert_season_stat(conn, player_id, source_id, stat, now)
        await _mark_published(conn, stat["_rawId"])
        result.records_published += 1


_DEMO_ADP_SOURCE_DEFAULTS: dict[str, Any] = {
    "adapterType": "FILE",
    "enabled": True,
    "termsUrl": None,
    "attribution": "DraftCourt demo ADP source — entirely synthetic sample data.",
    "permittedUses": ["demo", "development"],
    "rateLimitPerMinute": None,
    "lastComplianceReviewAt": None,
}


async def _publish_adp(
    conn: AsyncConnection,
    adp_observations: list[dict[str, Any]],
    player_id_by_key: dict[str, str],
    now: datetime,
    result: _PublishResult,
) -> None:
    adp_source_ids: dict[str, str] = {}
    for adp in adp_observations:
        player_id = player_id_by_key.get(adp["playerExternalKey"])
        if player_id is None:
            continue
        adp_source_id = adp_source_ids.get(adp["sourceExternalKey"])
        if adp_source_id is None:
            adp_source_id = await _get_or_create_source(
                conn, adp["sourceExternalKey"], dict(_DEMO_ADP_SOURCE_DEFAULTS)
            )
            adp_source_ids[adp["sourceExternalKey"]] = adp_source_id
        await conn.execute(
            db.adp_observations.insert().values(
                id=str(uuid.uuid4()),
                playerId=player_id,
                sourceId=adp_source_id,
                format=adp["format"],
                season=adp["season"],
                sampleSize=adp["sampleSize"],
                adp=adp["adp"],
                rank=adp["rank"],
                capturedAt=adp["capturedAt"],
            )
        )
        await _mark_published(conn, adp["_rawId"])
        result.records_published += 1

    if adp_observations:
        await _publish_adp_consensus(conn, player_id_by_key, adp_observations, now)


async def _publish_news_signals(
    conn: AsyncConnection,
    source_id: str,
    news_signals: list[dict[str, Any]],
    player_id_by_key: dict[str, str],
    *,
    now: datetime,
    result: _PublishResult,
) -> None:
    for signal in news_signals:
        player_id = player_id_by_key.get(signal["playerExternalKey"])
        if player_id is None:
            continue
        await conn.execute(
            db.player_news_signals.insert().values(
                id=str(uuid.uuid4()),
                playerId=player_id,
                type=signal["type"],
                impact=signal["impact"],
                confidence=signal["confidence"],
                rationale=signal["rationale"],
                adminApproved=True,  # demo signals are pre-approved fixture data
                sourceId=source_id,
                createdById=None,
                effectiveAt=signal["effectiveAt"],
                expiresAt=signal.get("expiresAt"),
                createdAt=now,
                updatedAt=now,
            )
        )
        await _mark_published(conn, signal["_rawId"])
        result.records_published += 1


async def _publish_override_seeds(
    conn: AsyncConnection,
    override_seeds: list[dict[str, Any]],
    player_id_by_key: dict[str, str],
    now: datetime,
    result: _PublishResult,
) -> None:
    if not override_seeds:
        return
    admin_id = (
        await conn.execute(
            select(db.users.c.id).where(db.users.c.clerkUserId == DEMO_ADMIN_CLERK_USER_ID)
        )
    ).scalar_one_or_none()
    for override in override_seeds:
        player_id = player_id_by_key.get(override["playerExternalKey"])
        if player_id is None or admin_id is None:
            continue
        await conn.execute(
            db.projection_overrides.insert().values(
                id=str(uuid.uuid4()),
                projectionRunId=None,
                adminId=admin_id,
                playerId=player_id,
                season=override["season"],
                stat=override["stat"],
                deltaValue=override.get("deltaValue"),
                replacementValue=override.get("replacementValue"),
                rationale=override["rationale"],
                status="ACTIVE",
                supersedesId=None,
                effectiveAt=override["effectiveAt"],
                expiresAt=override.get("expiresAt"),
                createdAt=now,
                updatedAt=now,
            )
        )
        await _mark_published(conn, override["_rawId"])
        result.records_published += 1


async def _mark_published(conn: AsyncConnection, raw_id: str) -> None:
    await conn.execute(
        db.raw_source_records.update()
        .where(db.raw_source_records.c.id == raw_id)
        .values(status="PUBLISHED")
    )


async def _upsert_team(conn: AsyncConnection, team: dict[str, Any], now: datetime) -> str:
    existing = (
        await conn.execute(
            select(db.nba_teams.c.id).where(db.nba_teams.c.nbaProviderId == team["nbaProviderId"])
        )
    ).scalar_one_or_none()
    if existing is not None:
        await conn.execute(
            db.nba_teams.update()
            .where(db.nba_teams.c.id == existing)
            .values(
                name=team["name"],
                city=team["city"],
                conference=team["conference"],
                division=team["division"],
                colorPrimary=team["colorPrimary"],
                colorSecondary=team["colorSecondary"],
                updatedAt=now,
            )
        )
        return str(existing)

    team_id = str(uuid.uuid4())
    await conn.execute(
        db.nba_teams.insert().values(
            id=team_id,
            nbaProviderId=team["nbaProviderId"],
            abbreviation=team["abbreviation"],
            name=team["name"],
            city=team["city"],
            conference=team["conference"],
            division=team["division"],
            colorPrimary=team["colorPrimary"],
            colorSecondary=team["colorSecondary"],
            createdAt=now,
            updatedAt=now,
        )
    )
    return team_id


async def _load_existing_players(
    conn: AsyncConnection, *, exclude_ids: frozenset[str] = frozenset()
) -> list[ExistingPlayer]:
    """Candidate pool for name/DOB reconciliation. Deliberately excludes
    `exclude_ids` — players created earlier in *this same* ingestion run
    from *this same* source. Name/DOB fuzzy matching exists to reconcile
    the *same real person* reported by two different sources under two
    different external IDs; it is not meant to disambiguate distinct
    people within one source's own batch, where every external key is
    already a guaranteed-unique identifier from that source. Without this
    exclusion, coincidentally similar real names in the same batch (e.g.
    Nikola Jokic vs. Nikola Jovic, or twin brothers Amen/Ausar Thompson)
    would spuriously flag each other as ambiguous."""
    rows = (
        await conn.execute(select(db.players.c.id, db.players.c.displayName, db.players.c.dob))
    ).all()
    return [
        ExistingPlayer(
            player_id=str(row.id),
            display_name=row.displayName,
            dob=row.dob.date() if row.dob is not None else None,
        )
        for row in rows
        if str(row.id) not in exclude_ids
    ]


async def _reconcile_and_publish_player(
    conn: AsyncConnection,
    source_id: str,
    player: dict[str, Any],
    team_id_by_key: dict[str, str],
    now: datetime,
    *,
    created_this_run: frozenset[str],
) -> tuple[str | None, bool]:
    """Returns `(player_id, unresolved)`. `unresolved=True` means a
    `CANDIDATE` identity row was written and no player data was published
    this run — a reviewable unresolved state, not an error."""
    external_key = player["externalKey"]

    existing_identity = (
        await conn.execute(
            select(
                db.player_external_identities.c.playerId,
                db.player_external_identities.c.status,
            ).where(
                db.player_external_identities.c.sourceId == source_id,
                db.player_external_identities.c.externalId == external_key,
            )
        )
    ).first()

    if existing_identity is not None and existing_identity.status == "CONFIRMED":
        player_id = str(existing_identity.playerId)
        await _apply_player_fields(conn, player_id, player, team_id_by_key, now)
        return player_id, False

    if existing_identity is not None and existing_identity.status == "CANDIDATE":
        return None, True  # still pending admin review from a prior run

    dob_value = date.fromisoformat(player["dob"])
    existing_players = await _load_existing_players(conn, exclude_ids=created_this_run)
    resolution = resolve_by_name_dob(player["displayName"], dob_value, existing_players)

    if resolution.status == "CONFIRMED":
        assert resolution.player_id is not None
        player_id = resolution.player_id
        await conn.execute(
            db.player_external_identities.insert().values(
                id=str(uuid.uuid4()),
                sourceId=source_id,
                externalId=external_key,
                playerId=player_id,
                candidateName=player["displayName"],
                candidateDob=dob_value,
                matchConfidence=resolution.confidence,
                matchMethod="NAME_DOB",
                status="CONFIRMED",
                createdAt=now,
                updatedAt=now,
            )
        )
        await _apply_player_fields(conn, player_id, player, team_id_by_key, now)
        return player_id, False

    if resolution.status == "CANDIDATE" and resolution.player_id is not None:
        # Plausible but not confident enough to auto-merge — reviewable
        # unresolved state (BUILD_SPEC.md section 7.2).
        await conn.execute(
            db.player_external_identities.insert().values(
                id=str(uuid.uuid4()),
                sourceId=source_id,
                externalId=external_key,
                playerId=None,
                candidateName=player["displayName"],
                candidateDob=dob_value,
                matchConfidence=resolution.confidence,
                matchMethod="NAME_DOB",
                status="CANDIDATE",
                createdAt=now,
                updatedAt=now,
            )
        )
        return None, True

    # No plausible match at all — genuinely new player.
    player_id = str(uuid.uuid4())
    slug_base = _slugify(player["displayName"])
    slug = await _unique_slug(conn, slug_base)
    await conn.execute(
        db.players.insert().values(
            id=player_id,
            slug=slug,
            displayName=player["displayName"],
            legalName=player["legalName"],
            dob=dob_value,
            status=player["status"],
            unsigned=player["unsigned"],
            rookie=player["rookie"],
            draftYear=player.get("draftYear"),
            currentTeamId=team_id_by_key.get(player.get("teamExternalKey") or ""),
            createdAt=now,
            updatedAt=now,
        )
    )
    await conn.execute(
        db.player_external_identities.insert().values(
            id=str(uuid.uuid4()),
            sourceId=source_id,
            externalId=external_key,
            playerId=player_id,
            candidateName=player["displayName"],
            candidateDob=dob_value,
            matchConfidence=1.0,
            matchMethod="PROVIDER_ID",
            status="CONFIRMED",
            createdAt=now,
            updatedAt=now,
        )
    )
    return player_id, False


async def _apply_player_fields(
    conn: AsyncConnection,
    player_id: str,
    player: dict[str, Any],
    team_id_by_key: dict[str, str],
    now: datetime,
) -> None:
    await conn.execute(
        db.players.update()
        .where(db.players.c.id == player_id)
        .values(
            displayName=player["displayName"],
            legalName=player["legalName"],
            status=player["status"],
            unsigned=player["unsigned"],
            rookie=player["rookie"],
            draftYear=player.get("draftYear"),
            currentTeamId=team_id_by_key.get(player.get("teamExternalKey") or ""),
            updatedAt=now,
        )
    )


async def _unique_slug(conn: AsyncConnection, base: str) -> str:
    candidate = base
    suffix = 2
    while True:
        existing = (
            await conn.execute(select(db.players.c.id).where(db.players.c.slug == candidate))
        ).scalar_one_or_none()
        if existing is None:
            return candidate
        candidate = f"{base}-{suffix}"
        suffix += 1


async def _publish_eligibility(conn: AsyncConnection, player_id: str, positions: list[str]) -> None:
    await conn.execute(
        db.player_eligibilities.delete().where(
            db.player_eligibilities.c.playerId == player_id,
            db.player_eligibilities.c.season == CURRENT_SEASON,
        )
    )
    for position in positions:
        await conn.execute(
            db.player_eligibilities.insert().values(
                id=str(uuid.uuid4()),
                playerId=player_id,
                season=CURRENT_SEASON,
                position=position,
            )
        )


async def _upsert_season_stat(
    conn: AsyncConnection, player_id: str, source_id: str, stat: dict[str, Any], now: datetime
) -> None:
    existing = (
        await conn.execute(
            select(db.player_season_stats.c.id).where(
                db.player_season_stats.c.playerId == player_id,
                db.player_season_stats.c.season == stat["season"],
                db.player_season_stats.c.scope == stat["scope"],
            )
        )
    ).scalar_one_or_none()

    values = {
        "gamesPlayed": stat["gamesPlayed"],
        "minutesTotal": stat["minutesTotal"],
        "pts": stat["pts"],
        "reb": stat["reb"],
        "ast": stat["ast"],
        "stl": stat["stl"],
        "blk": stat["blk"],
        "tov": stat["tov"],
        "fgm": stat["fgm"],
        "fga": stat["fga"],
        "ftm": stat["ftm"],
        "fta": stat["fta"],
        "threePm": stat["threePm"],
        "sourceId": source_id,
        "sourceRecordId": stat["_rawId"],
        "updatedAt": now,
    }
    if existing is not None:
        await conn.execute(
            db.player_season_stats.update()
            .where(db.player_season_stats.c.id == existing)
            .values(**values)
        )
        return
    await conn.execute(
        db.player_season_stats.insert().values(
            id=str(uuid.uuid4()),
            playerId=player_id,
            season=stat["season"],
            scope=stat["scope"],
            createdAt=now,
            **values,
        )
    )


async def _publish_adp_consensus(
    conn: AsyncConnection,
    player_id_by_key: dict[str, str],
    adp_observations: list[dict[str, Any]],
    now: datetime,
) -> None:
    """Sample-size-weighted mean across sources (BUILD_SPEC.md section 6.6).
    With exactly 2 demo sources there's nothing meaningful to trim; a real
    trimmed mean (drop the single highest and lowest observation) applies
    once >= 3 sources exist. `valueConfidence` is a simple, documented
    heuristic — BUILD_SPEC.md only requires "confidence is low with fewer
    than two sources," which this satisfies without overclaiming precision.
    """
    by_player: dict[str, list[dict[str, Any]]] = {}
    for obs in adp_observations:
        player_id = player_id_by_key.get(obs["playerExternalKey"])
        if player_id is None:
            continue
        by_player.setdefault(player_id, []).append(obs)

    if not by_player:
        return

    season = next(iter(by_player.values()))[0]["season"]
    snapshot_id = str(uuid.uuid4())
    await conn.execute(
        db.adp_consensus_snapshots.insert().values(
            id=snapshot_id,
            season=season,
            format="OVERALL",
            methodologyVersion="1",
            capturedAt=now,
        )
    )

    consensus_rows: list[tuple[str, float, float, int]] = []
    for player_id, observations in by_player.items():
        sorted_obs = sorted(observations, key=lambda o: float(o["adp"]))
        trimmed = sorted_obs[1:-1] if len(sorted_obs) >= _MIN_SOURCES_FOR_TRIM else sorted_obs
        total_weight = sum(o["sampleSize"] for o in trimmed)
        weighted_adp = sum(float(o["adp"]) * o["sampleSize"] for o in trimmed) / total_weight
        dispersion = float(sorted_obs[-1]["adp"]) - float(sorted_obs[0]["adp"])
        sources_count = len({o["sourceExternalKey"] for o in observations})
        consensus_rows.append((player_id, weighted_adp, dispersion, sources_count))

    consensus_rows.sort(key=lambda row: row[1])
    for rank, (player_id, weighted_adp, dispersion, sources_count) in enumerate(
        consensus_rows, start=1
    ):
        value_confidence = (
            0.3
            if sources_count < _MIN_SOURCES_FOR_CONFIDENCE
            else min(1.0, 0.3 + 0.2 * sources_count)
        )
        await conn.execute(
            db.adp_consensus_players.insert().values(
                id=str(uuid.uuid4()),
                snapshotId=snapshot_id,
                playerId=player_id,
                consensusAdp=round(weighted_adp, 2),
                dispersion=round(dispersion, 2),
                sourcesCount=sources_count,
                valueConfidence=value_confidence,
            )
        )
        del rank  # rank is implied by consensusAdp ordering at read time; not stored redundantly


__all__: list[str] = ["CURRENT_SEASON", "IngestionRunResult", "run_ingestion"]
