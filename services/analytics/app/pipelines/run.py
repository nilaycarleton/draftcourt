"""Orchestrates one baseline projection run: load normalized data ->
project every player -> apply active overrides/signals -> rank -> publish
atomically. Publish is atomic via `ProjectionRun.isCurrent`'s partial
unique index (`projection_runs_one_current_per_season`, see
docs/adr/0005-phase1-data-model.md): within one transaction, the
previously-current run for the season is flipped to `false` and the new
run to `true`, so a reader querying "the current run" never observes a
half-published state — either the previous complete run or the new
complete run, never neither and never both.
"""

from __future__ import annotations

import statistics
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from app.ingestion import db
from app.ingestion.checksum import checksum_of
from app.pipelines.adjustments import (
    ActiveOverride,
    ActiveSignal,
    apply_overrides,
    is_active,
    role_signal_impact,
)
from app.pipelines.baseline import PROJECTION_SEASON, PlayerContext, SeasonStatLine, project_player
from app.pipelines.scoring import fantasy_points

MODEL_KEY = "baseline-weighted-historical"
MODEL_VERSION = "1.0.0"
ALGORITHM = "WEIGHTED_BASELINE"

# Standard 9-category fantasy format used only to compute the Phase 1
# interim `overallRank` (see docs/adr/0005-phase1-data-model.md — the real
# roster/league-aware recommendation engine is Phase 2+). Percentage
# categories are volume-aware (BUILD_SPEC.md section 6.2): derived from
# summed makes/attempts across the pool, never from an average of ratios.
_Z_SCORE_STATS = ("pts", "reb", "ast", "stl", "blk", "threePm")
_TOV_REVERSED = True  # lower turnovers is better


@dataclass
class PlayerRunInput:
    player_id: str
    dob: date | None
    status: str
    unsigned: bool
    rookie: bool
    nba_lines: list[SeasonStatLine]
    college_line: SeasonStatLine | None
    signals: list[ActiveSignal]
    overrides: list[ActiveOverride]


@dataclass
class RunResult:
    run_id: str
    model_id: str
    season: str
    player_count: int
    input_checksum: str


async def _get_or_create_model(conn: AsyncConnection, now: datetime) -> str:
    existing = (
        await conn.execute(
            select(db.projection_models.c.id).where(
                db.projection_models.c.modelKey == MODEL_KEY,
                db.projection_models.c.version == MODEL_VERSION,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return str(existing)

    model_id = str(uuid.uuid4())
    await conn.execute(
        db.projection_models.insert().values(
            id=model_id,
            modelKey=MODEL_KEY,
            version=MODEL_VERSION,
            algorithm=ALGORITHM,
            featureSchemaChecksum=checksum_of(
                {"model_key": MODEL_KEY, "version": MODEL_VERSION, "algorithm": ALGORITHM}
            ),
            trainingWindowStartSeason="2023-24",
            trainingWindowEndSeason="2025-26",
            metrics=None,
            artifactUri=None,
            artifactChecksum=None,
            status="ACTIVE",
            createdAt=now,
            updatedAt=now,
        )
    )
    return model_id


async def _load_players(conn: AsyncConnection, *, as_of: datetime) -> list[PlayerRunInput]:
    player_rows = (
        await conn.execute(
            select(
                db.players.c.id,
                db.players.c.dob,
                db.players.c.status,
                db.players.c.unsigned,
                db.players.c.rookie,
            )
        )
    ).all()

    stat_rows = (
        await conn.execute(
            select(
                db.player_season_stats.c.playerId,
                db.player_season_stats.c.season,
                db.player_season_stats.c.scope,
                db.player_season_stats.c.gamesPlayed,
                db.player_season_stats.c.minutesTotal,
                db.player_season_stats.c.pts,
                db.player_season_stats.c.reb,
                db.player_season_stats.c.ast,
                db.player_season_stats.c.stl,
                db.player_season_stats.c.blk,
                db.player_season_stats.c.tov,
                db.player_season_stats.c.fgm,
                db.player_season_stats.c.fga,
                db.player_season_stats.c.ftm,
                db.player_season_stats.c.fta,
                db.player_season_stats.c.threePm,
            ).order_by(db.player_season_stats.c.season)
        )
    ).all()

    nba_lines_by_player: dict[str, list[SeasonStatLine]] = {}
    college_line_by_player: dict[str, SeasonStatLine] = {}
    for row in stat_rows:
        line = SeasonStatLine(
            season=row.season,
            scope=row.scope,
            games_played=row.gamesPlayed,
            minutes_total=row.minutesTotal,
            pts=row.pts,
            reb=row.reb,
            ast=row.ast,
            stl=row.stl,
            blk=row.blk,
            tov=row.tov,
            fgm=row.fgm,
            fga=row.fga,
            ftm=row.ftm,
            fta=row.fta,
            three_pm=row.threePm,
        )
        if row.scope == "NBA":
            nba_lines_by_player.setdefault(str(row.playerId), []).append(line)
        elif row.scope == "COLLEGE":
            college_line_by_player[str(row.playerId)] = line

    signal_rows = (
        await conn.execute(
            select(
                db.player_news_signals.c.id,
                db.player_news_signals.c.playerId,
                db.player_news_signals.c.type,
                db.player_news_signals.c.impact,
                db.player_news_signals.c.confidence,
                db.player_news_signals.c.effectiveAt,
                db.player_news_signals.c.expiresAt,
                db.player_news_signals.c.adminApproved,
            )
        )
    ).all()
    signals_by_player: dict[str, list[ActiveSignal]] = {}
    for row in signal_rows:
        if not row.adminApproved:
            continue  # BUILD_SPEC.md section 7.5: admin-approved or high-confidence only
        if not is_active(row.effectiveAt, row.expiresAt, as_of=as_of):
            continue
        signals_by_player.setdefault(str(row.playerId), []).append(
            ActiveSignal(
                id=str(row.id), type=row.type, impact=row.impact, confidence=row.confidence
            )
        )

    override_rows = (
        await conn.execute(
            select(
                db.projection_overrides.c.id,
                db.projection_overrides.c.playerId,
                db.projection_overrides.c.stat,
                db.projection_overrides.c.deltaValue,
                db.projection_overrides.c.replacementValue,
                db.projection_overrides.c.rationale,
                db.projection_overrides.c.effectiveAt,
                db.projection_overrides.c.expiresAt,
                db.projection_overrides.c.status,
            ).order_by(db.projection_overrides.c.effectiveAt)
        )
    ).all()
    overrides_by_player: dict[str, list[ActiveOverride]] = {}
    for row in override_rows:
        if row.status != "ACTIVE":
            continue
        if not is_active(row.effectiveAt, row.expiresAt, as_of=as_of):
            continue
        overrides_by_player.setdefault(str(row.playerId), []).append(
            ActiveOverride(
                id=str(row.id),
                stat=row.stat,
                delta_value=float(row.deltaValue) if row.deltaValue is not None else None,
                replacement_value=float(row.replacementValue)
                if row.replacementValue is not None
                else None,
                rationale=row.rationale,
            )
        )

    inputs: list[PlayerRunInput] = []
    for row in player_rows:
        player_id = str(row.id)
        nba_lines = sorted(nba_lines_by_player.get(player_id, []), key=lambda line: line.season)
        inputs.append(
            PlayerRunInput(
                player_id=player_id,
                dob=row.dob.date() if row.dob is not None else None,
                status=row.status,
                unsigned=row.unsigned,
                rookie=row.rookie,
                nba_lines=nba_lines,
                college_line=college_line_by_player.get(player_id),
                signals=signals_by_player.get(player_id, []),
                overrides=overrides_by_player.get(player_id, []),
            )
        )
    return inputs


def _pct(makes: float, attempts: float) -> float:
    return makes / attempts if attempts > 0 else 0.0


def _assign_overall_ranks(
    projected: list[tuple[PlayerRunInput, dict[str, float]]],
) -> dict[str, int]:
    """Standard-9-cat z-score composite, computed across this run's own
    eligible pool (BUILD_SPEC.md section 6.2's percentile/z-score approach,
    applied here only to produce Phase 1's interim overallRank — see
    module docstring)."""
    pool_values: dict[str, list[float]] = {stat: [] for stat in _Z_SCORE_STATS}
    pool_values["fg_pct"] = []
    pool_values["ft_pct"] = []
    pool_values["tov"] = []

    for _player, values in projected:
        for stat in _Z_SCORE_STATS:
            pool_values[stat].append(values[stat])
        pool_values["fg_pct"].append(_pct(values["fgm"], values["fga"]))
        pool_values["ft_pct"].append(_pct(values["ftm"], values["fta"]))
        pool_values["tov"].append(values["tov"])

    means = {stat: statistics.fmean(vals) if vals else 0.0 for stat, vals in pool_values.items()}
    stdevs = {
        stat: statistics.pstdev(vals) if len(vals) > 1 else 0.0
        for stat, vals in pool_values.items()
    }

    def z(stat: str, value: float) -> float:
        stdev = stdevs[stat]
        return (value - means[stat]) / stdev if stdev > 0 else 0.0

    scored: list[tuple[str, float]] = []
    for player, values in projected:
        composite = sum(z(stat, values[stat]) for stat in _Z_SCORE_STATS)
        composite += z("fg_pct", _pct(values["fgm"], values["fga"]))
        composite += z("ft_pct", _pct(values["ftm"], values["fta"]))
        composite -= z("tov", values["tov"]) if _TOV_REVERSED else -z("tov", values["tov"])
        scored.append((player.player_id, composite))

    scored.sort(key=lambda item: item[1], reverse=True)
    return {player_id: rank for rank, (player_id, _score) in enumerate(scored, start=1)}


async def publish_baseline_run(
    conn: AsyncConnection, *, reason: str, as_of: datetime | None = None
) -> RunResult:
    now = as_of or datetime.now(UTC)
    model_id = await _get_or_create_model(conn, now)
    inputs = await _load_players(conn, as_of=now)

    run_id = str(uuid.uuid4())
    input_checksum = checksum_of(
        sorted(
            [
                (p.player_id, [line.season for line in p.nba_lines], p.status, p.unsigned)
                for p in inputs
            ]
        )
    )
    await conn.execute(
        db.projection_runs.insert().values(
            id=run_id,
            modelId=model_id,
            season=PROJECTION_SEASON,
            dataCutoff=now,
            reason=reason,
            status="RUNNING",
            isCurrent=False,
            inputChecksum=input_checksum,
            startedAt=now,
            createdAt=now,
        )
    )

    projected: list[tuple[PlayerRunInput, dict[str, float]]] = []
    adjustment_audit: list[list[str]] = []
    for player in inputs:
        context = PlayerContext(
            dob=player.dob,
            status=player.status,  # type: ignore[arg-type]
            unsigned=player.unsigned,
            rookie=player.rookie,
            active_role_signal_impact=role_signal_impact(player.signals),
        )
        line = project_player(player.player_id, player.nba_lines, player.college_line, context)
        adjustment_result = apply_overrides(line, player.overrides)
        values = adjustment_result.line.model_dump(by_alias=True)
        projected.append((player, values))
        adjustment_audit.append([a.override_id for a in adjustment_result.applied])

    ranks = _assign_overall_ranks(projected)

    for player, values in projected:
        await conn.execute(
            db.player_projections.insert().values(
                id=str(uuid.uuid4()),
                runId=run_id,
                playerId=player.player_id,
                games=values["games"],
                minutesPerGame=values["minutesPerGame"],
                pts=values["pts"],
                reb=values["reb"],
                ast=values["ast"],
                stl=values["stl"],
                blk=values["blk"],
                tov=values["tov"],
                fgm=values["fgm"],
                fga=values["fga"],
                ftm=values["ftm"],
                fta=values["fta"],
                threePm=values["threePm"],
                lower80=values["lower80"],
                upper80=values["upper80"],
                injuryRisk=values["injuryRisk"],
                consistency=values["consistency"],
                upside=values["upside"],
                roleSecurity=values["roleSecurity"],
                overallRank=ranks[player.player_id],
                fantasyPoints=round(fantasy_points(values), 3),
                createdAt=now,
            )
        )

    # Atomic publish: unset the previous current run for this season, then
    # set the new one — both inside the same still-open transaction, so a
    # concurrent reader's query for "the current run" never sees zero or
    # two current rows (enforced by the partial unique index either way).
    await conn.execute(
        db.projection_runs.update()
        .where(
            db.projection_runs.c.season == PROJECTION_SEASON,
            db.projection_runs.c.isCurrent.is_(True),
        )
        .values(isCurrent=False)
    )
    await conn.execute(
        db.projection_runs.update()
        .where(db.projection_runs.c.id == run_id)
        .values(status="SUCCEEDED", isCurrent=True, finishedAt=now, publishedAt=now)
    )

    for override_ids in adjustment_audit:
        if not override_ids:
            continue
        await conn.execute(
            db.projection_overrides.update()
            .where(db.projection_overrides.c.id.in_(override_ids))
            .values(projectionRunId=run_id)
        )

    return RunResult(
        run_id=run_id,
        model_id=model_id,
        season=PROJECTION_SEASON,
        player_count=len(inputs),
        input_checksum=input_checksum,
    )


__all__: list[str] = [
    "ALGORITHM",
    "MODEL_KEY",
    "MODEL_VERSION",
    "RunResult",
    "publish_baseline_run",
]
