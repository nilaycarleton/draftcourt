#!/usr/bin/env bash
# Full quality gate: formatting, lint, typecheck, migrations, unit tests,
# contract validation, Playwright E2E, production builds (web + analytics
# container). Mirrors .github/workflows/ci.yml — run this before pushing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> [1/10] Formatting (Prettier + Ruff)"
pnpm format
(cd services/analytics && uv run ruff format --check .)

echo "==> [2/10] Lint (ESLint + Ruff)"
pnpm lint
(cd services/analytics && uv run ruff check .)

echo "==> [3/10] Typecheck (tsc --strict + mypy --strict)"
pnpm typecheck
(cd services/analytics && uv run mypy .)

# Migrations run before the unit test step because packages/db's tests are
# integration tests against a real, migrated Postgres — not mocked.
echo "==> [4/11] Database migrations against local Postgres"
docker compose up -d postgres redis
pnpm --filter @draftcourt/db run generate
pnpm db:migrate
pnpm db:seed

# Several TS unit tests (tests/unit/admin-*.test.ts, freshness-check.test.ts)
# and every Playwright E2E test assert against real published player/
# projection data — not mocked — so this must run before both.
echo "==> [5/11] Demo ingestion + baseline projection publish"
pnpm demo:ingest

echo "==> [6/11] JS/TS unit tests"
pnpm test

echo "==> [7/11] Python unit tests"
# Run pytest against the same migrated Postgres the rest of the gate uses so
# DB-backed integration tests execute instead of skipping. Only the exact
# variables are forwarded — sourcing .env.local wholesale would leak e.g.
# NODE_ENV=development into later steps and break the production build's
# static prerender (verified: /_global-error export crashes under dev mode).
PYTEST_DB_ENV="$(grep -E '^(DATABASE_URL|DIRECT_DATABASE_URL|SERVICE_SECRET)=' .env.local 2>/dev/null || true)"
(cd services/analytics && env ${PYTEST_DB_ENV} uv run pytest)

echo "==> [8/11] Shared contract fixtures (TS Zod vs Python Pydantic)"
bash scripts/verify-contracts.sh

echo "==> [9/11] Next.js production build"
pnpm --filter web run build

echo "==> [10/11] Playwright E2E smoke test"
pnpm --filter web run e2e

echo "==> [11/11] Analytics Docker image build + health check"
docker compose build analytics
docker compose up -d
sleep 5
curl -sf http://localhost:8000/health/live > /dev/null
curl -sf http://localhost:8000/health/ready > /dev/null
docker compose down

echo
echo "All quality gates passed."
