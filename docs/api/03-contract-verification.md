# Contract verification

How the TypeScript ↔ Python ↔ JSON-Schema contract is proven, step by
step. The pipeline exists for the analytics contract only: preference
schemas intentionally stay out of it (they never reach Python in this
slice — ADR 0011).

## Direction of truth

Zod (`packages/domain/src/contracts.ts`) → generated JSON Schema
(`data/schemas/*.schema.json`) → Pydantic validation in
`services/analytics` tested against shared fixtures
(`data/schemas/fixtures/*.json`).

## Run it

```bash
pnpm contracts:verify   # bash scripts/verify-contracts.sh
```

The script does exactly three things (`scripts/verify-contracts.sh:9-18`):

1. `pnpm contracts:generate` — regenerates JSON Schema from Zod, so drift
   shows up as a `git diff`. The generator covers four contracts —
   `league-scoring-rule`, `projected-line`, `score-component`,
   `recommendation` — emitted as draft-7 JSON Schema
   (`packages/domain/src/scripts/generate-schemas.ts`).
2. `pnpm --filter @draftcourt/domain run test` — Vitest, including
   `packages/domain/src/contracts.test.ts`, validates the fixtures
   against the Zod side.
3. `(cd services/analytics && uv run pytest tests/test_contracts.py)` —
   Pydantic validates the same fixtures on the Python side.

`pnpm contracts:generate` alone (`package.json`) refreshes the schemas
without running the suites.

## Files

| Path                                              | Role                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/domain/src/contracts.ts`                | Zod source of truth                                                                           |
| `packages/domain/src/scripts/generate-schemas.ts` | Zod → JSON Schema emitter                                                                     |
| `data/schemas/*.schema.json`                      | Generated: `league-scoring-rule`, `projected-line`, `recommendation`, `score-component`       |
| `data/schemas/fixtures/*.json`                    | Shared fixtures: `league-scoring-rule`, `projected-line`, `recommendation`, `score-component` |
| `packages/domain/src/contracts.test.ts`           | TS fixture acceptance/rejection                                                               |
| `services/analytics/tests/test_contracts.py`      | Python fixture acceptance/rejection                                                           |
| `services/analytics/app/domain/`                  | Pydantic mirrors                                                                              |
| `scripts/verify-contracts.sh`                     | Orchestrator (three steps above)                                                              |

Executable schemas win: if this page ever disagrees with the Zod source,
generated JSON Schema, or fixtures, the executable files govern and this
page must be fixed.

## OpenAPI locations

- Analytics (non-production only): `/openapi.json` and `/docs`. In
  production both are disabled (`openapi_url=None, docs_url=None`) —
  `services/analytics/app/main.py`.
- There is **no hosted web-API OpenAPI document** in the repo
  (unverified beyond the FastAPI surface above; do not cite one).
- Negative-case coverage for the internal surface is exercised through
  the analytics test suite, per BUILD_SPEC §16.2's Schemathesis intent;
  no Schemathesis harness was observed — **unverified, do not cite as
  present.**

## Sources

- `scripts/verify-contracts.sh`
- `package.json` (scripts `contracts:generate`, `contracts:verify`)
- `packages/domain/src/contracts.ts`
- `packages/domain/src/contracts.test.ts`
- `packages/domain/src/scripts/generate-schemas.ts`
- `data/schemas/` + `data/schemas/fixtures/`
- `services/analytics/tests/test_contracts.py`
- `services/analytics/app/domain/`
- `services/analytics/app/main.py`
- `docs/adr/0011-preference-storage-and-normalization.md`
- `BUILD_SPEC.md` §5, §16.2
