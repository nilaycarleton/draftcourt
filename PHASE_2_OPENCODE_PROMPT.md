# OpenCode Prompt — DraftCourt Phase 2

You are the primary implementation agent for DraftCourt, an NBA fantasy live draft assistant.

Your task is to finish the remaining Phase 1 gate and then complete **Phase 2 — League Setup and Live Draft Core**. Do not begin Phase 3.

Project root:

`/Users/nilay/Documents/NBA Fantasy Draft Helper`

## Source of truth and current state

Before changing anything:

1. Read the repository `AGENTS.md`, `BUILD_SPEC.md`, and `README.md` completely.
2. Read nested instruction files for every area you touch. In particular, follow `apps/web/AGENTS.md` and read the installed Next.js guides under `apps/web/node_modules/next/dist/docs/` before using Next.js APIs; do not rely on remembered framework behavior.
3. Read ADRs 0001–0009, especially:
   - `docs/adr/0002-postgres-and-prisma-ownership.md`
   - `docs/adr/0003-ui-and-motion.md`
   - `docs/adr/0008-background-jobs-and-caching.md`
   - `docs/adr/0009-admin-authorization.md`
4. Treat `sources/` as read-only and preserve unrelated user files.
5. Inspect the working tree before editing. Do not discard, overwrite, reformat, or commit unrelated changes.
6. Treat `BUILD_SPEC.md` as the implementation contract. If a generated skill recommendation conflicts with it, the build specification and accepted ADRs win unless you write and justify a superseding ADR.

The Phase 1 completion report records these verified facts:

- migrations: `20260820215725_init`, `20260821004305_phase1_player_data_projections`, and `20260821175840_add_fantasy_points_to_projections`;
- deterministic demo seed `20260820`, dataset version `2026.1`, checksums in `data/demo/manifest.json`;
- projection model `baseline-weighted-historical` version `1.0.0`;
- verified projection run `8e154e7d-d3b1-4b0e-b87d-a7eb121d40c3`, 230 players, 2026–27;
- synthetic evaluation: 204/230 evaluable, fantasy-points MAE 3.58, Spearman 0.966, games MAE 8.16;
- source mode is `demo-file`, not live sports data;
- the recorded final gate had 175 TS/JS unit tests, 137 passing Python tests with 14 intentional skips, and 90 Playwright cases passing.

Do not blindly trust the summary. Re-run the relevant gates and verify current repository evidence.

## Mandatory Graphify workflow

Graphify is already installed and the repository graph is already built under `graphify-out/`. Do not reinstall it and do not rebuild the entire graph before using it.

Use Graphify query-first instead of starting with broad grep/find scans:

1. Confirm the existing graph is queryable.
2. Run scoped queries for at least:
   - the Phase 1 refresh-job gap, analytics CLI pipeline, Inngest functions, circuit breaker, and atomic projection publish path;
   - Prisma models and code paths that must change for leagues, immutable settings versions, teams, roster rules, drafts, draft events, materialized rosters, and recommendation snapshots;
   - current authentication, authorization, API envelope, idempotency, cache, environment, and test conventions;
   - Astryx adapters, DraftCourt tokens, Motion usage, Phase 1 player-pool components, responsive patterns, and Storybook;
   - migration, seed, contract, integration, Playwright, accessibility, visual-regression, and benchmark infrastructure.
3. Use `graphify explain "<node>"` for high-degree shared nodes before modifying them.
4. Use `graphify path "<source>" "<target>"` to trace high-risk relationships, including:
   - analytics internal endpoint → projection pipeline/publish;
   - pick route → database transaction → draft event → roster read model → recommendation snapshot;
   - league scoring rules → projected player data → recommendation score;
   - UI draft action → optimistic state → version conflict reconciliation.
5. Treat Graphify edges marked `INFERRED` or `AMBIGUOUS` as hypotheses. Verify the relevant source and tests before editing.
6. Record the important Graphify queries and architectural findings in the implementation report or relevant ADR.
7. After material structural changes and passing tests, refresh the graph and query the changed paths again. Do not commit ephemeral Graphify cache output unless the repository already tracks that exact class of generated artifact.

Create a concise implementation plan mapped directly to the unresolved Phase 1 gate and every Phase 2 checklist item. Implement in complete vertical slices.

## Gate 0 — finish Phase 1 honestly

Phase 1 is not accepted yet. `BUILD_SPEC.md` correctly leaves refresh jobs and phase acceptance unchecked. Complete this blocker before Phase 2 feature work.

Implement the missing internal analytics HTTP surface and real scheduled workflows described by ADR 0008:

- service-authenticated, versioned internal endpoints for permitted ingestion/normalization and baseline projection generation/atomic publish;
- request timestamp/replay protection, service-secret validation, Pydantic input/output validation, idempotency, bounded timeouts, structured job state, trace propagation, and safe errors;
- Inngest functions that call the real analytics endpoints rather than shelling out or logging fabricated success;
- concurrency controls, bounded retry/backoff, and environment-safe schedules respecting demo/live source constraints;
- local/test invocation without paid infrastructure;
- circuit-breaker use on the first real web-to-analytics call;
- stale-data behavior, observability, and tests for success, duplicate delivery, authentication failure, timeout, retry, failed publish, and recovery;
- update ADR 0008, internal API documentation, runbooks, environment variables, README, and Graphify.

Also close the documented Clerk-sync gap only to the extent required for authenticated admin verification and correct Phase 2 ownership:

- implement and test the signed Clerk webhook/user mirror if it is still absent;
- retain server-controlled admin assignment;
- verify replay/idempotency and redaction;
- do not create a broader account-management product.

Re-run all Phase 1 acceptance checks. Only then mark the two remaining Phase 1 boxes complete. If the gate cannot be completed, stop and report the concrete blocker; do not start Phase 2.

## Impeccable frontend-design integration

Integrate [Impeccable](https://github.com/pbakaus/impeccable) as a project design workflow, not a runtime dependency or replacement component library.

1. Verify whether the project-scoped OpenCode Impeccable skill already exists. If absent, run the supported project-local installer for OpenCode:

   `npx impeccable install --providers=opencode --scope=project`

   If OpenCode must restart to discover the new skill, save the plan and exact resume point, restart/reload the harness, then continue. Do not pretend the skill ran if it was unavailable.
2. Run `/impeccable init` once and classify DraftCourt as a **product analytics dashboard/tool**, not a marketing surface.
3. Reconcile the generated `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, and configuration with `BUILD_SPEC.md` section 10 and ADR 0003. Preserve accepted existing tokens and accessible primitives. The build specification wins on conflict.
4. Keep shared design artifacts in version control. Add the official Impeccable ignore block so screenshots, runtime caches, live sessions, previews, annotations, and per-developer configuration remain untracked.
5. Before writing Phase 2 UI, run `/impeccable shape` for the complete league-setup and live-draft journey. The accepted shape must define:
   - information hierarchy and the primary drafting action;
   - the signature court-line selection/navigation treatment;
   - desktop and mobile transformations;
   - keyboard and focus behavior;
   - loading, empty, long-name, dense-board, stale, offline, error, double-submit, and version-conflict states;
   - reduced-motion, reduced-transparency, high-contrast, screen-reader, and 200% zoom behavior.
6. Implement only through `@draftcourt/ui`, Astryx adapters, semantic DraftCourt tokens, and Motion. Do not introduce another runtime component system. Do not use Anime.js in the live-draft critical path.
7. Avoid generic AI/SaaS design: no pure black/gray palette, gray text on colored surfaces, indiscriminate pills, excessive gradients/glow, cards nested inside cards, decorative rounded icon tiles, or animation without informational purpose.
8. Use a deliberate athletic/editorial typography system with licensed fonts and system fallbacks, tabular numerals, strong density, and WCAG-compliant contrast. Team colors are contextual accents only.
9. During implementation run Impeccable `critique`, `harden`, `adapt`, and `clarify` on the scoped flows. Before acceptance run `audit` and `polish`.
10. Treat Impeccable findings as review input, not self-approval. Resolve or explicitly document each material finding, then run the repository's independent Playwright, axe, visual-regression, bundle, and performance checks.

## Phase 2 scope

Complete **Phase 2 — League Setup and Live Draft Core** only:

1. points/category league setup wizard, custom weights, roster slots, punts, keeper/dynasty configuration, and league cloning;
2. draft/team/event/materialized-roster transactions and snake cursor;
3. responsive live board, player pool, permanent user roster, opponent rosters, and keyboard controls;
4. manual draft/search pick, undo, pause/resume/save/replay, optimistic reconciliation, and drafted states;
5. deterministic recommendation engine covering production, scarcity, roster need, risk, consistency, age, ADP value, upside, role, next-pick availability, preferences/default weights, explanations, labels, and score breakdown;
6. seeded next-pick availability simulation and shallow two-user-pick lookahead;
7. full Phase 2 tests, security, performance, documentation, migrations, and acceptance.

Do not implement Phase 3 CPU mock personalities, user preference profiles/presets, post-draft grades/sharing, custom ranks, or the full personalization product. Do not implement the Phase 4 trained ensemble, multi-source live ADP, Phase 5 AI, auction drafts, multiplayer rooms, trades, or waivers.

## 1. League setup and persistence

Implement the specification's Phase 2 database entities and contracts, including:

- `League`;
- immutable `LeagueSettingsVersion`;
- `LeagueTeam`;
- `RosterSlotRule`;
- `ScoringRule`;
- owner-scoped league cloning;
- Phase 2 draft tables described below.

Requirements:

- Prisma remains the sole migration owner.
- Use forward-only expand/migrate/contract changes; verify migration from the completed Phase 1 database and from a fresh database.
- Support 4–20 teams, explicit user draft slot, snake rounds, points/custom-category scoring, 8-cat and 9-cat presets expanded into custom rules, roster/bench positions, custom points/category weights, higher/lower-better direction, punts, playoff-week setting, REDRAFT/KEEPER/DYNASTY horizon, and retained players.
- Validate totals, duplicates, unsupported stat keys, impossible roster counts, duplicate team slots, invalid keeper players, and season mismatches at the schema and service boundaries.
- Keep settings immutable once a draft starts. Editing a league creates a new settings version; an active draft retains its snapshot.
- Clone the league configuration without copying private drafts or histories.
- Enforce owner authorization before data access and test cross-user ID enumeration.

Build:

- `GET/POST /api/v1/leagues`;
- `GET/PATCH/DELETE /api/v1/leagues/:id`;
- `POST /api/v1/leagues/:id/clone`;
- `/leagues/new` multi-step wizard;
- `/leagues/[id]/settings` editor/clone flow;
- dashboard entry points only as needed for this flow.

The wizard must support save-and-resume setup, clear review before starting, inline validation, meaningful defaults, keyboard operation, mobile layout, and a plain-language explanation of points, categories, percentages, lower-is-better, and punts.

## 2. Event-sourced draft core

Implement:

- `Draft`;
- immutable `DraftTeam` snapshot;
- append-only `DraftEvent`;
- `DraftRosterAssignment` materialized read model;
- `RecommendationSnapshot`;
- the transaction/outbox/job mechanism required by the specification.

Enforce all invariants:

- draft events are never deleted or rewritten;
- monotonic per-draft sequence;
- unique `(draftId, sequence)` and `(draftId, idempotencyKey)`;
- one effective selection per player per draft;
- append event, update materialized roster, update snake cursor, increment draft version, and enqueue recommendation work in one database transaction;
- mutations require `Idempotency-Key` and `If-Match` draft version;
- return a safe 409 with authoritative state on a collision;
- undo is a compensating `PICK_UNDONE` event referencing the latest effective `PLAYER_DRAFTED` event;
- Phase 2 undo affects only the latest effective pick;
- pause/resume/start/complete status transitions are validated;
- replay from events exactly reconstructs the read model and cursor;
- retained keepers enter as explicit immutable pre-draft events or the exact representation defined in the updated ADR, never as hidden mutations.

Implement and document exact snake-draft math for every round, slot, and 4–20 teams. Add property-based tests for forward sequence, reverse mapping, next user pick, undo, and replay determinism.

Build:

- `GET/POST /api/v1/drafts`;
- `GET /api/v1/drafts/:id`;
- `POST /api/v1/drafts/:id/start`;
- `POST /api/v1/drafts/:id/picks`;
- `POST /api/v1/drafts/:id/undo`;
- `POST /api/v1/drafts/:id/pause`;
- `POST /api/v1/drafts/:id/resume`;
- `GET /api/v1/drafts/:id/events`;
- `GET /api/v1/drafts/:id/recommendations`;
- `POST /api/v1/drafts/:id/recommendations/recalculate` only if the specified idempotent authorization/rate-limit contract is complete.

Do not add CPU-pick behavior in this phase.

## 3. Deterministic recommendation engine

Implement the engine in `packages/domain`; the server is authoritative. Keep pure scoring and simulation logic isolated from framework/database code.

Inputs must be immutable snapshots of:

- league settings version;
- active draft events through sequence `s`;
- current materialized rosters;
- published projection run;
- available demo ADP snapshot;
- active signals/overrides;
- default Phase 2 factor weights derived from reciprocal rank;
- engine version.

Canonically sort and hash inputs. Persist the checksum and engine/projection versions. The same inputs and seed must produce byte-equivalent logical output.

Implement the exact BUILD_SPEC formulas and behavior for:

- points-league per-game/season production blend;
- volume-aware category impact for FG% and FT%; do not average percentages;
- lower-is-better categories and punts;
- replacement-relative category z-scores;
- multi-position maximum-weight roster-slot matching;
- value above positional replacement and reduced UTIL/BENCH multipliers;
- required-slot coverage and candidate-added roster simulation;
- category win-probability utility and diminishing returns near dominant categories;
- risk/safety, consistency, age, upside, role, default preference contribution, and optional schedule;
- ADP value with honest low-confidence/demo labels;
- no same-NBA-team penalty;
- legal availability and unsigned-player behavior;
- deterministic explanation templates using the two largest positives and largest material caveat;
- 0–100 score, deterministic tie breaks, component breakdown, confidence, and Best Overall/Best Fit/Best Value/Highest Upside/Safest Pick labels.

Build top-three recommendations plus a sortable complete-pool breakdown. Do not use an LLM.

## 4. Next-pick availability and lookahead

Implement a seeded opponent-selection simulator for availability estimation only, not the Phase 3 mock-draft product.

- Run 250 deterministic simulations live and 2,000 in offline evaluation.
- Simulated intervening selections use a documented softmax of ADP, baseline projection, legal roster need, and a minimal versioned tendency vector.
- Update the tendency vector from observed real picks without creating user preference profiles.
- Availability equals the fraction of simulations in which the player reaches the user's next pick.
- Use urgency as specified, including the one-point tie-break rule.
- For the top 20 base candidates, perform the shallow two-user-pick rollout and cap its contribution at 10%.
- Never allow simulations to select drafted or illegal players.
- Seed from the input checksum plus explicit engine seed, not wall-clock time.

Benchmark and optimize only after correctness. Meet the specification's warm/cold p95 targets on the standard 12-team, 16-round, 600-player fixture, and publish the benchmark method and result.

## 5. Live draft UX

Build `/drafts/new` and `/drafts/[id]` using the accepted Impeccable shape and BUILD_SPEC section 9.

Desktop:

- draft status bar with league, round/pick, picks until the user's turn, save/connection state, pause, and undo;
- virtualized visual snake board as the main surface;
- sticky top-three recommendations and always-visible user roster;
- searchable/filterable player pool and opponent roster access;
- recommendation detail with exact component math, data snapshot, engine version, confidence, availability, and caveat.

Mobile:

- sticky pick/status bar;
- recommendations-first hierarchy;
- explicit board, available-player, and roster tabs;
- interruptible accessible detail sheet;
- one-thumb draft action protected from double submission;
- no page-level horizontal overflow at 320 px.

Required behavior:

- drafted players remain visible with pick/team state and disabled action;
- optimistic pick display followed by authoritative reconciliation;
- version conflicts restore authoritative state and explain the change without losing focus;
- calculating/stale/offline/read-only states are explicit;
- user's roster remains readily accessible;
- full event replay and reload restoration work;
- search-to-draft and click-to-draft are fast but provide a visible confirmation affordance;
- shortcuts `/`, arrows, Enter, `D`, `U`, `R`, `B`, `M`, `?`, and Escape work without conflicting with text entry;
- a polite live region announces meaningful picks and recommendations without flooding screen readers;
- semantic list/table alternative for the visual board;
- focus is restored after draft, undo, close, and conflict actions;
- all touch targets are at least 44×44 CSS px;
- light/dark, reduced motion/transparency, high contrast, color-blind-safe states, long names, 200% zoom, and 320 px are verified.

Use Motion for transform/opacity-based, interruptible transitions and layout continuity. Do not animate the same property with another library. Do not add a celebration during the live draft.

## 6. Security, concurrency, resilience, and observability

- Require Clerk authentication for real drafts and owner authorization for every league/draft operation.
- Keep drafts private by default. Phase 3 sharing is out of scope.
- Validate all input/output with Zod/Pydantic/shared schemas.
- Rate-limit draft creation and recommendation recalculation without making pick correctness depend on Redis.
- PostgreSQL transactions and optimistic versioning are the correctness mechanism; Redis locks are optional optimization only.
- Cache keys include settings hash, projection run, ADP snapshot, draft sequence, engine version, and input checksum.
- Never use stale cache for pick legality.
- If Redis fails, recompute. If analytics fails, use the last published projection run and show freshness. If PostgreSQL fails, disable mutations and show an explicit read-only state.
- Redact auth headers, cookies, idempotency keys, private draft identifiers where appropriate, and service secrets from logs/Sentry.
- Add trace IDs across pick mutation, recommendation work, analytics, and persistence.
- Measure pick latency, conflicts, recommendation latency/cache hits/errors, replay failures, and stale projection use.

## 7. Tests and required verification

Add unit/property tests for:

- league validation, settings immutability, custom scoring, punts, and clone isolation;
- snake math for 4–20 teams and every slot/round;
- roster matching and no-valid-slot cases;
- event append/replay/idempotency/undo/status/version conflicts;
- points/category/percentage/lower-better formulas;
- scarcity, replacement, diminishing returns, weights, labels, explanations, and score bounds;
- seeded simulation reproducibility, availability bounds, lookahead cap, and illegal-player prevention;
- canonical input checksum stability.

Add database/route/integration tests for:

- fresh and Phase 1 migrations;
- owner isolation and cross-user enumeration;
- all league/draft API success, validation, auth, idempotency, and conflict paths;
- atomic event/read-model/cursor/version/outbox transaction rollback;
- concurrent duplicate and competing picks;
- Redis unavailable, analytics unavailable, stale projections, and PostgreSQL read-only behavior;
- internal analytics authentication/replay/idempotency and real refresh/publish workflows;
- Sentry redaction and trace propagation.

Playwright must cover:

- points and custom-category league wizards;
- keeper/dynasty setup and league clone;
- create/start a short manual draft;
- search/click/keyboard pick;
- every team roster and snake-board update;
- top-three recommendation update and details;
- duplicate/conflicting pick reconciliation;
- undo, pause, resume, reload, and replay;
- drafted player state;
- desktop/mobile/light/dark/reduced-motion/high-contrast/200%-zoom/320-px layouts;
- keyboard-only and focus restoration;
- axe with zero serious or critical findings;
- visual regression for setup, populated board, recommendations, conflict, loading, empty, and error states.

Before declaring completion:

1. Verify Graphify queries and paths before edits and after graph refresh.
2. Complete and accept the Impeccable shape, critique, harden, adapt, audit, and polish workflow.
3. Install from committed locks and verify no accidental dependency drift.
4. Start PostgreSQL, Redis, analytics, Inngest dev mode, Storybook, and web.
5. Apply migrations from fresh and completed Phase 1 databases.
6. Seed and ingest/publish deterministic demo data.
7. Prove the scheduled refresh/publish workflow and authenticated Clerk mirror.
8. Run formatting, ESLint, Ruff, strict TypeScript, mypy, unit, property, contract, integration, E2E, axe, visual-regression, migration, and security checks.
9. Build Next.js, Storybook, and the FastAPI Docker image; health-check services.
10. Run recommendation and pick benchmarks and record environment, fixture checksum, p50/p95/p99, engine version, and date.
11. Run the complete root `pnpm test:all` gate from a clean state.
12. Verify there are no production placeholders, skipped required tests, hidden demo-data claims, or Phase 3 features.

## Documentation and completion report

Update:

- `BUILD_SPEC.md` checkboxes only when evidence satisfies section 25;
- README routes/setup/current-phase status;
- ERD and event replay/recommendation sequence diagrams;
- recommendation methodology with worked points and category examples;
- OpenAPI/shared contracts;
- ADRs for Phase 1 internal analytics jobs, Phase 2 event sourcing/concurrency, recommendation engine/simulation, and Impeccable design workflow;
- threat model and runbooks for conflict recovery, stale projections, failed recommendation work, replay divergence, and rollback;
- `PRODUCT.md`, `DESIGN.md`, accepted Impeccable reports, and Graphify graph/report according to repository tracking policy.

In the final report:

- lead with whether the Phase 1 gate and Phase 2 are fully complete;
- list every material file or subsystem changed;
- report exact commands and results;
- report migrations, engine version, input/seed strategy, test totals, axe/visual results, Graphify queries, Impeccable commands/findings, and benchmark p50/p95/p99;
- report any residual security, accessibility, data, performance, beta dependency, or deployment risk;
- distinguish verified facts from inferences;
- do not mark Phase 2 complete or begin Phase 3 while any required gate is failing.

If anything remains broken or unverified, continue fixing it. Do not present partial work as complete.
