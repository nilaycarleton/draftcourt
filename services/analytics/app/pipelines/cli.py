"""CLI entrypoint for the baseline projection pipeline — `uv run python -m
app.pipelines.cli publish` computes and atomically publishes one baseline
run against whatever normalized player data is currently in Postgres
(run `app.ingestion.cli` first). Kept as a separate module/process from
ingestion (BUILD_SPEC.md section 7.2's pipeline stages are sequential but
distinct — `extract/validate/normalize/reconcile` vs. `predict/publish`),
matching the separate `IngestionRun` vs. `ProjectionRun` tables.
"""

from __future__ import annotations

import asyncio
import json

import typer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.ingestion import db
from app.pipelines.evaluation import EvaluationReport, run_evaluation
from app.pipelines.report import build_eval_cases, write_report
from app.pipelines.run import MODEL_KEY, MODEL_VERSION, RunResult, publish_baseline_run

app = typer.Typer(help="DraftCourt analytics projection CLI")


async def _run_publish(reason: str) -> RunResult:
    settings = get_settings()
    engine = create_async_engine(settings.asyncpg_database_url)
    try:
        async with engine.begin() as conn:
            return await publish_baseline_run(conn, reason=reason)
    finally:
        await engine.dispose()


@app.command()
def publish(reason: str = "scheduled baseline refresh") -> None:
    """Compute and atomically publish one baseline projection run."""
    configure_logging()
    result = asyncio.run(_run_publish(reason))
    typer.echo(
        json.dumps(
            {
                "runId": result.run_id,
                "modelId": result.model_id,
                "season": result.season,
                "playerCount": result.player_count,
                "inputChecksum": result.input_checksum,
            },
            indent=2,
        )
    )


async def _run_evaluate() -> tuple[EvaluationReport, int]:
    settings = get_settings()
    engine = create_async_engine(settings.asyncpg_database_url)
    try:
        async with engine.connect() as conn:
            cases = await build_eval_cases(conn)
            total_players = len((await conn.execute(select(db.players.c.id))).all())
    finally:
        await engine.dispose()
    report = run_evaluation(
        cases, model_key=MODEL_KEY, model_version=MODEL_VERSION, cutoff_season="2025-26"
    )
    return report, total_players


@app.command()
def evaluate() -> None:
    """Run the time-ordered backtest and write the evaluation report to
    models/baseline-v1/."""
    configure_logging()
    report, total_players = asyncio.run(_run_evaluate())
    write_report(report, total_players=total_players)
    all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
    typer.echo(
        json.dumps(
            {
                "modelKey": report.model_key,
                "modelVersion": report.model_version,
                "evaluableCases": all_metrics.n,
                "totalPlayers": total_players,
                "fantasyPointsMae": all_metrics.fantasy_points_mae,
                "spearmanRankCorrelation": all_metrics.spearman_rank_correlation,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    app()
