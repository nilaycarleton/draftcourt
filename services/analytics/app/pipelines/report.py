"""Assembles `EvalCase`s from normalized Postgres data and renders the
evaluation report (JSON + Markdown) to `models/baseline-v1/`, per
BUILD_SPEC.md section 7.4: "Persist or export a human-readable evaluation
report connected to the model version."
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from app.ingestion import db
from app.pipelines.baseline import PlayerContext, SeasonStatLine
from app.pipelines.evaluation import EvalCase, EvaluationReport

_REQUIRED_NBA_SEASONS = ("2023-24", "2024-25", "2025-26")


def _default_report_dir() -> Path:
    """Locate `models/baseline-v1` without assuming checkout depth (same
    container-safety reasoning as file_adapter._default_data_dir: only
    `app/` exists in the image, so indexing parents[4] raised IndexError at
    import and crash-looped the container). Override with EVAL_REPORT_DIR."""
    configured = os.getenv("EVAL_REPORT_DIR")
    if configured:
        return Path(configured)
    probe = Path(__file__).resolve().parent
    while probe != probe.parent:
        candidate = probe / "models" / "baseline-v1"
        if candidate.is_dir():
            return candidate
        probe = probe.parent
    return probe / "models" / "baseline-v1"


REPORT_DIR = _default_report_dir()


async def build_eval_cases(conn: AsyncConnection) -> list[EvalCase]:
    """Only players with exactly the 3 documented NBA seasons on record
    are evaluable — the two oldest train the projection, the newest is
    the held-out target (BUILD_SPEC.md section 16.4: time-ordered split,
    never random)."""
    player_rows = (
        await conn.execute(
            select(
                db.players.c.id,
                db.players.c.displayName,
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
            ).where(db.player_season_stats.c.scope == "NBA")
        )
    ).all()

    lines_by_player: dict[str, dict[str, SeasonStatLine]] = {}
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
        lines_by_player.setdefault(str(row.playerId), {})[row.season] = line

    cases: list[EvalCase] = []
    for row in player_rows:
        player_id = str(row.id)
        seasons = lines_by_player.get(player_id, {})
        if not all(season in seasons for season in _REQUIRED_NBA_SEASONS):
            continue  # not evaluable by this methodology — see module docstring
        train_lines = [seasons[_REQUIRED_NBA_SEASONS[0]], seasons[_REQUIRED_NBA_SEASONS[1]]]
        actual = seasons[_REQUIRED_NBA_SEASONS[2]]
        cases.append(
            EvalCase(
                player_id=player_id,
                display_name=row.displayName,
                train_lines=train_lines,
                actual=actual,
                context=PlayerContext(
                    dob=row.dob.date() if row.dob is not None else None,
                    status=row.status,
                    unsigned=row.unsigned,
                    rookie=row.rookie,
                ),
            )
        )
    return cases


def _render_markdown(report: EvaluationReport, *, total_players: int, generated_at: str) -> str:
    lines = [
        "# Baseline projection evaluation report",
        "",
        f"- Model: `{report.model_key}` @ `{report.model_version}`",
        f"- Cutoff season (held out): `{report.cutoff_season}`",
        f"- Generated: {generated_at}",
        f"- Total players in dataset: {total_players}",
        "",
        "> **This is a benchmark against DraftCourt's own fabricated demo "
        "season history (see data/attribution/demo-dataset.md), not a "
        "measurement of real-world NBA prediction accuracy.** Every "
        "statistic below is fabricated; the methodology (time-ordered "
        "split, leakage prevention, subgroup breakdown) is real and reused "
        "unchanged once real historical data is available.",
        "",
        "## Methodology",
        "",
        "Players with all 3 demo NBA seasons on record have their oldest "
        "two seasons fed to the baseline as training input; the projection "
        "is compared against the (synthetic) third season, which the model "
        "never sees. This is a rolling time-ordered split, never a random "
        "one — see `app/pipelines/evaluation.py` and "
        "`app/pipelines/report.py::build_eval_cases`.",
        "",
        "## Subgroup results",
        "",
        "| Subgroup | n | Fantasy pts MAE | Games MAE | Spearman ρ | Interval coverage |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for subgroup in report.subgroups:
        rho = (
            "n/a"
            if subgroup.spearman_rank_correlation is None
            else f"{subgroup.spearman_rank_correlation:.3f}"
        )
        lines.append(
            f"| {subgroup.subgroup} | {subgroup.n} | {subgroup.fantasy_points_mae:.2f} | "
            f"{subgroup.games_played_mae:.2f} | {rho} | {subgroup.interval_coverage:.1%} |"
        )

    lines += [
        "",
        "## Minutes-weighted per-stat MAE (all players)",
        "",
        "| Stat | MAE (per game) |",
        "| --- | ---: |",
    ]
    all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
    for stat, value in all_metrics.minutes_weighted_mae.items():
        lines.append(f"| {stat} | {value:.3f} |")

    lines += [
        "",
        "## Evaluation limitations",
        "",
        f"- `rookie` and `unsigned` subgroups have `n = "
        f"{report.not_evaluable_counts.get('rookie', 0)}` / "
        f"`{report.not_evaluable_counts.get('unsigned', 0)}` respectively: "
        "this backtest methodology requires 3 full prior NBA seasons to "
        "hold one out, which rookies and (in this dataset) unsigned "
        "players never have by construction. Their fallback paths are "
        "unit-tested directly (see `tests/pipelines/test_baseline.py`) "
        "but not covered by this held-out-season backtest.",
        "- `interval_coverage` measures whether the *heuristic* `lower80`/"
        "`upper80` band contains the actual value — it is a sanity check, "
        "not evidence of true 80% statistical calibration (see "
        "`app/pipelines/baseline.py`'s module docstring).",
        "- All figures are computed against synthetic data and must not be "
        "read as a claim about real 2026-27 NBA prediction accuracy.",
        "",
    ]
    return "\n".join(lines)


def write_report(
    report: EvaluationReport, *, total_players: int, out_dir: Path = REPORT_DIR
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(UTC).isoformat()

    metrics_payload = {
        "modelKey": report.model_key,
        "modelVersion": report.model_version,
        "cutoffSeason": report.cutoff_season,
        "generatedAt": generated_at,
        "totalPlayers": total_players,
        "notEvaluableCounts": report.not_evaluable_counts,
        "subgroups": [
            {
                "subgroup": s.subgroup,
                "n": s.n,
                "minutesWeightedMae": s.minutes_weighted_mae,
                "fantasyPointsMae": s.fantasy_points_mae,
                "gamesPlayedMae": s.games_played_mae,
                "spearmanRankCorrelation": s.spearman_rank_correlation,
                "intervalCoverage": s.interval_coverage,
            }
            for s in report.subgroups
        ],
    }
    (out_dir / "metrics.json").write_text(
        json.dumps(metrics_payload, indent=2) + "\n", encoding="utf-8"
    )
    (out_dir / "evaluation-report.md").write_text(
        _render_markdown(report, total_players=total_players, generated_at=generated_at),
        encoding="utf-8",
    )


__all__: list[str] = ["REPORT_DIR", "build_eval_cases", "write_report"]
