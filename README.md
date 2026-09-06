# DraftCourt

DraftCourt is a platform-independent NBA fantasy live draft assistant. As picks come off the board, it recommends the best three available players for the user's roster, league rules, future projections, draft market, and personal strategy—and explains every score mathematically.

The initial target is the 2026–27 NBA season. This repository is currently at the specification stage; [BUILD_SPEC.md](./BUILD_SPEC.md) is the implementation contract.

## What the product will do

- support points and custom-category snake leagues;
- model redraft, keeper, and dynasty preferences;
- track a complete live board and every manager's roster through manual picks;
- undo, pause, resume, save, replay, and run CPU mock drafts;
- show three live recommendations with a 0–100 score, reason, risk, confidence, ADP value, and next-pick availability;
- account for positional scarcity, roster need, category balance, diminishing returns, injuries, consistency, age, upside, role, schedule, and user preferences;
- provide player profiles, advanced filters, 2–4-player comparisons, saved history, and post-draft grades;
- offer guest demo mocks and private authenticated real drafts;
- later add a trained projection ensemble, premium grounded OpenAI assistant, and in-season trade/waiver tools.

## Product principles

1. **Fit over generic rank.** The best pick depends on the active roster and league.
2. **Explainable by default.** Every recommendation is reproducible and decomposes into visible score components.
3. **Fast during a draft.** The interface responds immediately and the server remains authoritative.
4. **User agency.** Preferences, punt strategies, targets, avoids, and undo are first-class.
5. **Honest uncertainty.** Projections show confidence, freshness, risk, and source limitations.
6. **Private by default.** Drafts belong to their owner; sharing is explicit, read-only, and revocable.

## Planned architecture

```text
Next.js/React web and API layer
        ├── Clerk authentication
        ├── deterministic TypeScript recommendation engine
        ├── PostgreSQL/Prisma (authoritative data and event history)
        ├── Redis (cache and rate limits)
        └── FastAPI/Python analytics
                 ├── ingestion and validation
                 ├── projection training/evaluation
                 └── versioned projection publishing
```

The monorepo will use pnpm/Turborepo. Production targets are Vercel for the web app, Neon PostgreSQL, Upstash Redis, Render for the containerized FastAPI service, Inngest for workflows, Clerk for identity, and Sentry for monitoring. Local development uses Docker Compose for PostgreSQL, Redis, and analytics.

## Recommendation model at a glance

The default priority is projected production, positional scarcity, roster need, injury risk, consistency, age, ADP value, upside, role/minutes, next-pick availability, and personal preference. Users can reorder and tune these factors.

For each available legal player, the engine:

1. calculates league-specific points or volume-aware category value;
2. measures value above positional replacement;
3. simulates the candidate on the user's roster;
4. models risk, consistency, age, upside, role, preferences, ADP, and optional playoff schedule;
5. estimates survival to the next user pick with seeded CPU simulations;
6. performs a shallow lookahead to avoid obvious future roster traps;
7. returns a deterministic 0–100 score and component-level explanation.

The future AI assistant may convert natural-language goals into bounded, visible preference changes. It may not invent data or directly replace the deterministic score.

## Implemented so far

Phases 0–2 (data pipeline, league wizard, event-sourced live drafts, deterministic recommendations) and the preference foundation plus its integration are working locally: signed-in managers build strategy profiles at `/preferences`, select one per league or override it before starting a draft, and every started draft captures an immutable, checksummed snapshot of that strategy which drives bounded, explainable personalization in the live recommendations. Editing a profile affects only future drafts. History and deterministic post-draft analysis are also working: after completing a mock or real draft, open `/history` to filter by type/status/league/date and load more via cursor, then `/drafts/[id]/results` for the `A–F` grade (`90/80/70/60`), 5 component bars, round-by-round value with `DeltaChip` reach, strengths/weaknesses, and `2000`-run synthetic standing (`P50`/`P90`) vs a replacement-built opponent; disclosure `This analysis is a projection, not a guarantee` and `analysisVersion 1.0.0` + `inputChecksum` are shown, with `HIGH` only when `projection ≤48h && adp ≤7d && sources≥2 ≥80%` else `LOW`. Demo drafts never appear in history. See [BUILD_SPEC.md](./BUILD_SPEC.md) §24 for the phase checklist and [docs/architecture/preferences.md](./docs/architecture/preferences.md) for the design.

## Frontend direction

The interface is a minimalist, futuristic NBA analytics dashboard with equally polished light and dark themes. The live desktop view keeps the visual board, top three recommendations, and user's roster visible; mobile uses recommendations-first tabs and an interruptible bottom sheet.

Integration plan for the requested repositories:

- [Astryx](https://github.com/facebook/astryx): accessible React primitives behind a local adapter and pinned because it is beta.
- [Apple design skill](https://github.com/emilkowalski/skills/tree/main/skills/apple-design): interaction guidance—immediate feedback, interruptible motion, spatial consistency, restraint, and accessible reduced-motion alternatives. It is not a runtime package.
- [Motion](https://github.com/motiondivision/motion): primary React animation library for layout, cards, sheets, press states, and springs.
- [Anime.js](https://github.com/juliangarnier/anime): lazy-loaded decorative SVG/chart sequences only, outside the live draft critical path.

## Intended repository layout

```text
apps/web                 Next.js application
services/analytics       FastAPI projections and ingestion
packages/db              Prisma schema, migrations, seed
packages/domain          contracts and deterministic recommendation logic
packages/ui              DraftCourt components and design tokens
data                     schemas, demo data, attribution
models                   model cards and metadata
docs                     ADRs, architecture, methodology, runbooks
infra                    Docker and monitoring configuration
```

## Delivery phases

Numbered to match BUILD_SPEC.md's own phase sections (0-indexed).

0. Foundation, contracts, CI, auth shell, design system. **Done.**
1. Data pipeline, baseline projections, player pages, admin overrides. **Done.**
2. League setup, event-sourced live draft, recommendation engine.
3. Preferences, CPU mocks, post-draft analysis, accessibility and benchmarks.
4. Trained projection ensemble and permitted multi-source market intelligence.
5. Premium grounded AI.
6. Separately specified trade/waiver tools and platform adapters.

Each phase must be complete—including migrations, tests, documentation, accessibility, security, and production build—before the next begins.

## How Codex should begin

1. Read [BUILD_SPEC.md](./BUILD_SPEC.md) in full.
2. Start at Phase 0 in its phased checklist.
3. Create the monorepo structure and architecture decision records before feature work.
4. Pin compatible stable versions and commit lockfiles; do not assume a beta frontend API.
5. Implement one complete vertical slice at a time.
6. Run the full relevant quality gate after each slice and fix failures before continuing.
7. Mark a checklist item complete only when it satisfies the shared definition of done.

Do not use mock recommendation logic in production, silently scrape prohibited sources, expose secrets/private drafts, skip failing checks, or move to a later phase with unfinished acceptance criteria.

## Development quick start

Status: Phases 0–1 complete (foundation; data, baseline projections, player
experience — including scheduled refresh/publish workflows over the analytics
service's authenticated internal API and the signed Clerk webhook user
mirror). Phase 2 backend is complete: league persistence with immutable
settings versions, the event-sourced draft core (append-only events,
optimistic concurrency, undo/pause/resume/replay), and the deterministic
recommendation engine with seeded availability simulation and lookahead.
Phase 2 surfaces (`/leagues/new` wizard, `/drafts/[id]` room) are implemented;
polish/virtualization passes continue. See BUILD_SPEC.md section 24 for the
authoritative per-item status.

**Every number in this deployment is synthetic.** Player, team, and
position names are real, public facts; every statistic, projection, and
ADP value is fabricated for demonstration and generated by a deterministic
seed (`data/demo/generate.py`) — see `data/attribution/demo-dataset.md`
for the full disclosure, and `/data-sources` / `/methodology` in the
running app for the same thing in plain language.

### Prerequisites

| Tool           | Version used                   | Notes                                                                                                                  |
| -------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Node.js        | 24.18.0 (see `.node-version`)  | Current LTS ("Krypton")                                                                                                |
| pnpm           | 11.22.0                        | `corepack enable && corepack use pnpm@11.22.0`, or see [pnpm.io/installation](https://pnpm.io/installation)            |
| Python         | 3.12.5 (see `.python-version`) | Pinned below the system default (3.14) for ecosystem maturity — see `docs/adr/0001-monorepo-and-service-boundaries.md` |
| uv             | latest                         | [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/) — manages the Python virtualenv/lockfile  |
| Docker Desktop | latest                         | Runs local Postgres, Redis, and the analytics service                                                                  |

### First-time setup

```bash
git clone <repo-url> draftcourt && cd draftcourt
pnpm bootstrap
```

`pnpm bootstrap` copies `.env.example` → `.env.local` (no secrets — Clerk,
Sentry, and other optional integrations stay disabled locally), installs
JS/TS and Python dependencies, starts Postgres/Redis via Docker Compose,
generates the Prisma client, applies migrations, seeds one deterministic
demo admin user, generates the shared JSON Schema contracts, and ingests +
publishes the Phase 1 demo player/projection dataset (`pnpm demo:ingest`)
— `pnpm dev` afterward has a populated player pool immediately, no extra
steps.

### Everyday commands

```bash
pnpm dev             # analytics (:8000) + web (:3100), both with hot reload
pnpm demo:ingest     # re-run ingestion + publish a fresh baseline projection run
pnpm test            # JS/TS unit tests across all packages (Vitest)
pnpm test:all        # full quality gate — see scripts/test-all.sh for the 11 steps
pnpm db:migrate      # apply committed Prisma migrations (packages/db/prisma/migrations)
pnpm db:seed         # re-run the deterministic demo seed
pnpm lint            # ESLint (all TS packages)
pnpm typecheck       # tsc --noEmit (all TS packages)
pnpm storybook       # DraftCourt component/token showcase at :6106
```

Python-specific commands run from `services/analytics`:

```bash
cd services/analytics
uv run uvicorn app.main:app --reload --port 8000   # standalone, without pnpm dev
uv run ruff format . && uv run ruff check .          # format + lint
uv run mypy .                                        # strict typecheck
uv run pytest                                         # unit tests + coverage
```

### Local URLs

- Web: <http://localhost:3100> (health: `/api/health`)
  - `/players` — searchable player pool, baseline projections, internal rank, demo ADP
  - `/players/[slug]` — player profile (projection, risk/role indicators, historical trend)
  - `/compare` — 2–4 player comparison, shareable `?players=slug1,slug2,...` URL
  - `/data-sources`, `/methodology` — provenance and baseline-methodology explanation
  - `/admin/projections`, `/admin/signals`, `/admin/audit-log` — admin-only override/signal
    management (403/sign-in-gated without a configured Clerk admin session — see
    `docs/adr/0009-admin-authorization.md`)
  - `/api/v1/players`, `/api/v1/players/[slug]`, `/api/v1/players/compare`,
    `/api/v1/rankings`, `/api/v1/data-sources`, `/api/v1/admin/*`
- Analytics (internal-only in production; open locally for development): <http://localhost:8000> (`/health/live`, `/health/ready`, `/docs` outside production)
- Storybook: <http://localhost:6106>
- Postgres: `localhost:55432` (not 5432 — see below)
- Redis: `localhost:6379`

### Troubleshooting

- **Postgres port 5432/5433 already in use**: Compose maps the local
  Postgres container to host port **55432** by default specifically to
  avoid this (override with `POSTGRES_HOST_PORT` in `.env.local` if 5432
  is actually free on your machine). `DATABASE_URL`/`DIRECT_DATABASE_URL`
  in `.env.example` already point at 55432.
- **Web port 3000 in use**: `apps/web` defaults to port **3100**
  (`PORT=3100` in scripts), not Next.js's default 3000, to avoid clashing
  with other local projects. Override with `PORT=<port>`.
- **Prisma client not found**: run `pnpm --filter @draftcourt/db run generate`
  — it's gitignored and regenerated from `packages/db/prisma/schema.prisma`.
- **Clerk/Sentry pages look inert**: expected without real credentials.
  `/sign-in`/`/sign-up` render an explanatory message, and Sentry silently
  no-ops with an empty `SENTRY_DSN`. Add real keys to `.env.local` to
  enable either.

## Documentation map

- [BUILD_SPEC.md](./BUILD_SPEC.md): complete product and engineering contract.
- `docs/architecture/`: context, service, component, ERD, and event-replay diagrams.
- `docs/recommendation-engine.md`: formulas and worked examples.
- `docs/data-sources.md`: provenance, permissions, attribution, freshness, limitations.
- `docs/adr/`: architecture decisions.
- `models/`: model cards and evaluation summaries.
- `docs/runbooks/`: deploy, rollback, restore, stale-data, source-disable, and incident procedures.

## License and data note

The application code license, sports-data licenses, player images, and team marks must be reviewed separately before a public release. DraftCourt must not imply NBA endorsement. Every data adapter must document permitted use, attribution, rate limits, freshness, and a shutdown path.
