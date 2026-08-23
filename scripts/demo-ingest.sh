#!/usr/bin/env bash
# Runs the full demo data path: ingest the deterministic demo dataset
# through the real source-adapter/validation/reconciliation pipeline, then
# compute and atomically publish one baseline projection run. Safe to
# re-run — ingestion dedupes by checksum, and publishing a run only ever
# adds a new run (see docs/adr/0007-baseline-projection-methodology.md).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# services/analytics's Settings looks for `.env.local` relative to its own
# working directory (none exists there — only the repo-root one does), so
# export the variables it needs here first; real env vars take priority
# over dotenv-file loading in pydantic-settings regardless of cwd.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

cd services/analytics

echo "==> Ingesting the demo dataset (data/demo/*.json)"
uv run python -m app.ingestion.cli

echo "==> Publishing a baseline projection run"
uv run python -m app.pipelines.cli publish

echo
echo "Demo data ready. Start the app with: pnpm dev"
