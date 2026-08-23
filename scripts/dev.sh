#!/usr/bin/env bash
# Runs web + analytics for local development. Requires `pnpm bootstrap` first.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

cleanup() {
  echo
  echo "==> Stopping analytics service"
  kill "${ANALYTICS_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Ensuring Postgres and Redis are running"
docker compose up -d postgres redis

echo "==> Starting analytics service on :8000"
(cd services/analytics && uv run uvicorn app.main:app --reload --port 8000) &
ANALYTICS_PID=$!

echo "==> Starting web on :3100"
pnpm --filter web run dev
