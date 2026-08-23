#!/usr/bin/env bash
# One-command Phase 0 bootstrap: install toolchains, start infra, migrate, seed.
# Safe to re-run. See README.md "Development quick start".
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Checking required toolchains"
command -v pnpm >/dev/null || { echo "pnpm not found — see https://pnpm.io/installation"; exit 1; }
command -v uv >/dev/null || { echo "uv not found — see https://docs.astral.sh/uv/getting-started/installation/"; exit 1; }
command -v docker >/dev/null || { echo "docker not found — see https://docs.docker.com/get-docker/"; exit 1; }

if [ ! -f .env.local ]; then
  echo "==> Creating .env.local from .env.example"
  cp .env.example .env.local
fi

echo "==> Installing JS/TS dependencies (pnpm)"
pnpm install

echo "==> Installing Python dependencies (uv)"
(cd services/analytics && uv sync)

echo "==> Starting Postgres and Redis (Docker Compose)"
docker compose up -d postgres redis

echo "==> Waiting for Postgres to be healthy"
until docker compose ps postgres --format '{{.Health}}' | grep -q healthy; do
  sleep 1
done

echo "==> Generating Prisma client"
pnpm --filter @draftcourt/db run generate

echo "==> Applying database migrations"
pnpm db:migrate

echo "==> Seeding deterministic demo data"
pnpm db:seed

echo "==> Generating JSON Schema contracts"
pnpm contracts:generate

echo "==> Ingesting demo data and publishing a baseline projection run"
pnpm demo:ingest

echo
echo "Bootstrap complete. Next: pnpm dev"
