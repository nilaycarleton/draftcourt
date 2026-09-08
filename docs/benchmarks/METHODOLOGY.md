# Benchmark methodology

How to re-run every benchmark and what a result file must contain. This
page cites result files **by name only** — no latency, throughput, or
machine numbers appear here. Read the numbers (if needed) in the JSONs
themselves, qualified by their embedded `environment`/`date`/`commit`
fields.

## Fixtures

All benches drive the deterministic demo dataset (`data/demo/*.json`)
through synthetic draft shapes (e.g. a 12-team × 16-round board at
several depths for recommendations). Fixtures are illustrative load
shapes on fabricated data — they say nothing about real-NBA performance
or fantasy outcomes.

## Warm vs cold

- **Cold**: recompute at that sequence (no usable cached snapshot).
- **Warm**: serve the checksum-addressed cached snapshot.
- `cacheState` in the newer JSONs records which mode a timing belongs
  to; `seedPolicy` records how simulation seeds were derived.

## Re-run commands

From the repo root unless noted (scripts live in `apps/web/scripts/`):

| Bench                 | Command                                                                                                     | Result file                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Recommendations       | `pnpm --filter web run bench:recommendations`                                                               | `docs/benchmarks/recommendations-latest.json`  |
| Preferences scenarios | `pnpm --filter web run bench:preferences`                                                                   | `docs/benchmarks/preferences-latest.json`      |
| CPU mock              | `pnpm --filter web run bench:cpu-mock`                                                                      | `docs/benchmarks/cpu-mock-latest.json`         |
| Demo drafts           | `pnpm --filter web run bench:demo`                                                                          | `docs/benchmarks/demo-drafts-latest.json`      |
| History + analysis    | `npx tsx apps/web/scripts/bench-analysis.ts` (no npm script wired — observed gap; run `tsx` directly)       | `docs/benchmarks/history-analysis-latest.json` |
| Replay + sharing      | `npx tsx apps/web/scripts/bench-replay-sharing.ts` (no npm script wired — observed gap; run `tsx` directly) | `docs/benchmarks/replay-sharing-latest.json`   |

Benches need a migrated database with published demo data
(`pnpm db:migrate && pnpm db:seed && pnpm demo:ingest`); several write
timing rows only to the JSON file, never to product tables. (Script
headers, e.g. `apps/web/scripts/bench-recommendations.ts:1-12`.)

## Required fields for every result file

`machine` (or `environment`), `commit`, dataset/fixture identity
(`fixture`, and where applicable `analysisInputChecksum` /
`simulationSeedPolicy`), percentiles (`p50`/`p95`/`p99` with `n`), and
`date`. Current coverage is uneven — honest accounting:

| File                           | Has date | Has commit | Has environment/fixture | Notes                    |
| ------------------------------ | -------- | ---------- | ----------------------- | ------------------------ |
| `recommendations-latest.json`  | yes      | **no**     | yes/yes                 | add `commit` on next run |
| `preferences-latest.json`      | yes      | **no**     | yes/yes                 | add `commit` on next run |
| `cpu-mock-latest.json`         | yes      | **no**     | yes/yes                 | add `commit` on next run |
| `demo-drafts-latest.json`      | yes      | yes        | yes/yes                 | complete                 |
| `history-analysis-latest.json` | yes      | yes        | yes/yes                 | complete                 |
| `replay-sharing-latest.json`   | yes      | yes        | yes/yes                 | complete                 |

Do not compare files across machines or commits as if they were one
experiment. Do not present any figure against the BUILD_SPEC §6.9
budgets without naming the file, its `date`, and its `environment`.

## Sources

- `BUILD_SPEC.md` §6.9, §16.5, §19
- `apps/web/scripts/bench-recommendations.ts`
- `apps/web/scripts/bench-preferences.ts`
- `apps/web/scripts/bench-cpu-mock.ts`
- `apps/web/scripts/bench-demo-drafts.ts`
- `apps/web/scripts/bench-analysis.ts`
- `apps/web/scripts/bench-replay-sharing.ts`
- `apps/web/package.json` (bench script wiring)
- `docs/benchmarks/recommendations-latest.json`
- `docs/benchmarks/preferences-latest.json`
- `docs/benchmarks/cpu-mock-latest.json`
- `docs/benchmarks/demo-drafts-latest.json`
- `docs/benchmarks/history-analysis-latest.json`
- `docs/benchmarks/replay-sharing-latest.json`
