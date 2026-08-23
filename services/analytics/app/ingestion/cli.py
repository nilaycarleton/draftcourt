"""CLI entrypoint for the ingestion pipeline — `uv run python -m
app.ingestion.cli demo` runs the full pipeline against the demo file
adapter end-to-end, locally or in CI, without any server running
(BUILD_SPEC.md section 13: "callable in local/test environments without
requiring paid infrastructure"). Also backs the
`POST /internal/v1/ingestion/:source` internal API route, which calls
`run_ingestion` directly rather than shelling out to this CLI.
"""

from __future__ import annotations

import asyncio
import json

import typer
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.ingestion.file_adapter import DemoFileAdapter
from app.ingestion.pipeline import IngestionRunResult, run_ingestion

app = typer.Typer(help="DraftCourt analytics ingestion CLI")


async def _run_demo() -> IngestionRunResult:
    settings = get_settings()
    engine = create_async_engine(settings.asyncpg_database_url)
    try:
        adapter = DemoFileAdapter()
        async with engine.begin() as conn:
            return await run_ingestion(conn, adapter)
    finally:
        await engine.dispose()


@app.command()
def demo() -> None:
    """Run the full ingestion pipeline against the demo file dataset."""
    configure_logging()
    result = asyncio.run(_run_demo())
    typer.echo(
        json.dumps(
            {
                "runId": result.run_id,
                "traceId": result.trace_id,
                "status": result.status,
                "recordsExtracted": result.records_extracted,
                "recordsValidated": result.records_validated,
                "recordsQuarantined": result.records_quarantined,
                "recordsPublished": result.records_published,
                "unresolvedIdentities": result.unresolved_identities,
                "checksum": result.checksum,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    app()
