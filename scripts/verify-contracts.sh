#!/usr/bin/env bash
# Validates that the TypeScript (Zod) and Python (Pydantic) contract mirrors
# in packages/domain and services/analytics/app/domain both accept/reject the
# same fixtures in data/schemas/fixtures, and regenerates the JSON Schema
# files so drift shows up as a git diff.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Regenerating JSON Schema from Zod contracts"
pnpm contracts:generate

echo "==> Validating TypeScript contract fixtures (Vitest)"
pnpm --filter @draftcourt/domain run test

echo "==> Validating Python contract fixtures (Pytest)"
(cd services/analytics && uv run pytest tests/test_contracts.py)

echo "Contracts verified."
