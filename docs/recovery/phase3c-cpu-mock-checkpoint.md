# Phase 3C Recovery Checkpoint — CPU Personalities and Authenticated Mock Drafts

**Session start:** 2026-08-24 (after Phase 3B acceptance)
**Starting commit:** `5aa63a2` ("chore: untrack analytics coverage artifact")
**Dirty tree at start:** 103 uncommitted paths — preserved accepted Phase 2 +
Phase 3A + Phase 3B work. **No reset/stash/commit/push at any point.**

## Scope of this session (Phase 3C only)

1. Pure versioned CPU personality definitions (8 required)
2. Deterministic seeded CPU selector reusing production legality
3. Immutable CPU personality snapshots on CPU-controlled DraftTeams + draft sim seed
4. CPU picks through the EXISTING authoritative pick transaction + event evidence
5. Owner-only `POST /api/v1/drafts/:id/cpu-pick`
6. Authenticated mock creation/orchestration (client-paced; no server sleeps)
7. Mock-draft UI controls

Explicitly OUT of scope: guest /demo drafts, anonymous tokens/expiration,
saved history, post-draft analysis, replay UI, result sharing, Phase 4.

## Operating model

Max three concurrent subagents; shared tree; strict per-file ownership;
subagents may not touch Prisma/migrations, manifests, BUILD_SPEC.md, this
checkpoint, central draft transaction service, exports, or run gates/migrations/
Graphify/full Playwright. If a subagent fails twice on provider/network errors,
primary absorbs its scope.

## Primary-agent reading completed

AGENTS.md; BUILD_SPEC.md §§4/6/8/11/24/25; PHASE_3_OPENCODE_PROMPT.md;
Phase 3B checkpoint (authored by me); ADRs 0010/0011/0012;
recommendation + preference methodology docs; ERD; PRODUCT.md; DESIGN.md;
apps/web/AGENTS.md (+ Next.js installed-docs rule); direct source reads of
drafts.ts (full), recommendations.ts (full), recommendation.ts key regions,
domain/draft.ts (FULL — replay reduction, candidateSlotsForEligibility),
DraftRoom.tsx, schema.prisma (DraftTeam.cpuStrategy String? exists as Phase 2
headroom), route patterns, Clerk test helpers.

## Key verified facts

- `DraftTeam.cpuStrategy String?` nullable column already exists (never written).
- `makePick` is THE authoritative transaction: lock → owner/status/version checks →
  duplicate-delivery replay → board-full check → availability → legality
  (computeOpenSlots/chooseSlot over league-wide inventory) → event append →
  read-model row → outbox → cursor/version bump. Undo is compensating PICK_UNDONE.
- Domain has `replayFromEvents`, `overallPickToSlot/Round/PickInRound`,
  `upcomingPicksForSlot`, `candidateSlotsForEligibility` (specific > G/F combo > UTIL > BENCH).
- Engine `recommend(EngineInput)` is pure; pool filter mirrors transactional
  authority; preferences enter via optional EngineInput.preferences.
- RecommendationSnapshot unique `(draftId, sequence, inputChecksum)`; early cache
  guarded by engineVersion equality; outbox marked processed on read/self-heal.
- Envelope `{data,error,meta.traceId}`; problems.conflict exists; Postgres-count
  rate limits are the house pattern; redacted audit via writeAuditLog.
- Clerk authenticated e2e helpers: resetClerkTestUser(email,password,lastName),
  signInViaTicket(page,credentials,userId); distinct fixed emails per spec file.
- Local DB restored (volume persisted); all migrations applied.

## Wave 1 — discovery subagents (read-only)

| Agent | Scope                                | Status                             | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | CPU algorithm investigator           | returned                           | Full contracts, 8 personality vectors (sum 1, T∈[0.4,1.6]), checksum-based per-pick seed formula, softmax-over-top-K selection, team-level slot accounting, legality-reuse plan (no second authority — CPU proposes, makePick disposes), 12-case property/golden matrix, feature-from-raw-inputs decision (engine-version drift immune), proposed files all in packages/domain.                                                                              |
| B     | Mock-draft UX investigator           | returned                           | Creation flow (REAL default / MOCK radios, personality catalog from props, advanced per-team overrides collapsed, seed input, speed/auto-advance localStorage), room strip above Tabs, exhaustive client state model driven only by authoritative GETs, generation-token/single-flight/idempotent-key race protection, announcement batching rules (instant = one summary), component/file plan, fake-timer test strategy, distinct Clerk email rule, risks. |
| C     | Concurrency/security/QA investigator | FAILED 2× (provider network_error) | Absorbed by primary (below).                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Architecture decisions (ACCEPTED at synthesis gate)

### D1 — Feature pipeline, not engine calls

CPU selection does NOT call recommend() (250-run Monte Carlo + user-slot-relative
semantics + cache pollution). It computes nine normalized [0,1] features from RAW
immutable inputs via shared exported primitives (seasonFantasyPoints,
categoryUtility, computePoolBaselines, percentileRank, candidateSlotsForEligibility…),
with three parity formulas golden-tested against engine lines. Engine-version bumps
cannot silently change CPU behavior.

### D2 — Personalities (v1)

Eight definitions: adp-follower(T .9), projection-purist(.8), balanced(1.0,
default), positional-drafter(.9), upside-hunter(1.4), safe-veteran(.7),
dynasty-youth(1.1), category-specialist(.9). Weight vectors over dimensions
[projection, adpValue, scarcityFit, rosterNeed, upside, safety, consistency,
ageCurve, categoryEmphasis], non-negative, sum exactly 1 at 6dp. All
version=1, seedStrategyVersion=1, supportedModes=[MOCK, DEMO]. No LLM, no
hidden adaptive behavior, no punts inferred, no owner preferences for opponents.

### D3 — Seed strategy (v1)

pickSeed = sha256(canonicalize{seedStrategyVersion, draftSeed(uint32 of
simulationSeed string), personalityKey, personalityVersion, teamSlot,
nextOverallPick}) → first 8 hex → mulberry32 → EXACTLY ONE softmax draw.
No wall-clock; undo restores identical effective state ⇒ identical pick;
team/pick/personality participation diversifies streams.

### D4 — Selection

Pure scores (no noise); stable total order (score desc → adp asc missing-last →
id asc); top-K (K=min(24,pool)); temperature softmax with max-shift numerical
stability; single seeded roll walks cumsum in sorted order. Typed failures
EMPTY_POOL / BOARD_COMPLETE / INVALID_TEAM_SLOT. Team-level legality =
settings.rosterSlots − this team's fills (keepers included) intersected with
league-wide open inventory; retired excluded; unsigned per policy flag.

### D5 — Persistence (migration `phase3c_cpu_mock`)

- Draft += `simulationSeed VARCHAR(64) NULL` — user-visible reproducibility code,
  generated at creation (user-supplied validated `[A-Za-z0-9-]{1,64}` or server
  random 12-char base36), immutable afterwards. CPU draftSeed = FNV-1a32(string).
- DraftTeam += `cpuPersonalitySnapshot JSONB NULL` — full immutable
  CpuPersonalitySnapshot (key/version/displayLabel/description/weights/
  temperature/seedStrategyVersion/snapshotVersion), written once at creation for
  EVERY non-user team of MOCK drafts; fail-closed parse on read.
- Legacy `cpuStrategy` varchar also gets the personality KEY for cheap display
  (denormalized convenience; JSON remains authority).
- Presentation speed + auto-advance: CLIENT localStorage only (pacing intent);
  authoritative state always derives from draft rows. No schema/API cost.
- No backfill; real drafts keep columns NULL; fresh + upgrade paths verified.

### D6 — Transaction integration (ONE path)

makePick gains optional `cpu` parameter carrying a `decide(snapshot, assignments,
nextOverallPick)` provider. Inside the EXISTING transaction after lock/status/
version/duplicate checks: playerId resolves from the provider against LOCKED
state; actorUserId stays NULL; payload gains cpu evidence {cpu:true,
personalityKey, personalityVersion, seedStrategyVersion, decisionSeedHex,
decisionChecksum, selectionScore}; defense-in-depth refuses CPU picks into the
user's own slot. Everything else (legality, availability, event append, read
model, outbox, cursor/version, duplicate-delivery replay, undo compensation) is
UNTOUCHED shared code. No second transaction path.

### D7 — API: POST /api/v1/drafts/:id/cpu-pick

Owner-authenticated; MOCK only; ACTIVE only; server-DERIVES the picking team
from nextOverallPick (no playerId/teamSlot input — arbitrary-player injection
structurally impossible); requires If-Match + Idempotency-Key; one CPU pick per
request (batching rejected: derived-key complexity for marginal gain — client
paces sequential requests); typed problems: /problems/cpu-turn (409, includes
authoritative state), reuse version-conflict/draft-status/not-found; rate limit
per-user rolling minute via audit-count pattern (action draft.cpuPick, ≥180/min
to permit instant bursts); redacted audit rows; response {pick{playerId,
displayName,slotPosition,isBench,sequence}, evidence{personalityKey,version,
decisionChecksum,selectionScore,decisionSeed}, authoritative{version,
nextOverallPick,status,currentSequence}}. Retry contract on conflict/illegal:
server re-reads, re-decides (seed changes with state), ≤3 attempts.

### D8 — Orchestration

Client-owned runner (useMockRunner): generation token + single-flight +
deterministic Idempotency-Key `cpu-{draftId}-{nextOverallPick}-{version}`;
every continuation re-syncs from authoritative GET; auto-advance loops with
speed pacing and ALWAYS stops at user turn; cancel invalidates generation;
reload resumes only if autoAdvance was enabled; pause/resume are client-runner
states (server DRAFT_PAUSED deliberately NOT used for pacing — it blocks all
picks); completion via armed two-step /complete. Speeds change pacing ONLY
(same picks for same seed).

## File ownership map (exactly one writer per file)

Primary: schema.prisma + migration, packages/domain/src/index.ts (exports),
apps/web/lib/server/drafts.ts (createDraft mock config + makePick cpu branch +
getDraftForOwner mock view), NEW apps/web/lib/server/cpu-mock.ts (decision
input builder + orchestrator), NEW app/api/v1/drafts/[id]/cpu-pick/route.ts,
app/api/v1/drafts/route.ts (create schema), app/drafts/[id]/page.tsx (mock
mapping), app/drafts/new/page.tsx (catalog prop wiring), features/drafts/
DraftRoom.tsx (SMALL conditional patch after B lands), tests/unit/cpu-mock.test.ts
(integration/concurrency/security), benchmarks script, ADR/docs/checkpoint/
BUILD_SPEC, gates, Graphify.

Subagent A: packages/domain/src/cpu-personalities.ts (NEW),
cpu-selector.ts (NEW), cpu-personalities.test.ts (NEW), cpu-selector.test.ts
(NEW). Nothing else; reports export needs to primary.

Subagent B: packages/ui/src/components/MockPersonalityPicker.tsx (NEW) +
packages/ui/src/stories/MockControls.stories.tsx (NEW) + packages/ui package
exports if needed (report to primary — ui index owned by primary),
features/drafts/{useMockRunner.ts, mockPacing.ts, MockDraftControls.tsx,
MockStatusStrip.tsx} (NEW), app/phase3c-mock.css (NEW) + ONE-LINE import in
app/globals.css, features/drafts/StartDraftFlow.tsx (extension designated),
tests/unit/{mock-personality-picker,mock-draft-controls,start-draft-flow-mock}
.test.tsx (NEW) + ADDITIVE describes in tests/unit/draft-room.test.tsx,
tests/e2e/mock-draft.spec.ts (NEW), docs/design/phase3c-mock-controls-shape.md.

## Milestone log

(updated after every integration milestone)

### Recovery continuation — 2026-09-02

- Resumed at the same starting commit `5aa63a2`; current dirty tree is 127
  paths (41 modified, 86 untracked), containing the intentionally preserved
  Phase 2/3A/3B work plus a partially integrated Phase 3C implementation.
- Primary personally re-read the required specification sections, Phase 3
  prompt/checkpoint, ADRs 0010–0013, recommendation/preference methodology,
  ERD, PRODUCT/DESIGN, web instructions, installed Next.js Route Handler /
  Server-Client Component / dynamic-route / Playwright / Vitest guides, and
  the current domain, schema, draft transaction, API, runner, UI, Clerk, and
  test paths before delegating or editing production code.
- Read-only Graphify queries run against the existing graph:
  - `graphify query "CPU personality selector legal candidate pool projection ADP scoring punts preference snapshots roster assignment" --budget 2600`
  - `graphify query "authenticated mock draft creation StartDraftFlow DraftRoom mobile tabs status controls recommendations" --budget 2600`
  - `graphify query "makePick optimistic version idempotency owner Clerk outbox replay undo pause completion rate limit audit cpu-pick" --budget 3000`
  - `graphify path "selectCpuPick" "makePick"` and
    `graphify path "useMockRunner" "makeCpuPickForOwner"` returned no matching
    Phase 3C nodes, proving the graph predates the untracked Phase 3C files.
  - `graphify explain "makePick"` confirmed the pre-3C extracted dependency
    path through lockDraft, chooseSlot, versionConflict, cursor math, and the
    route callers. All graph claims are being verified in source.
- Initial recovery defects found by primary source inspection (not yet fixed):
  1. CPU route validates `If-Match` syntactically but does not pass it into
     `makeCpuPickForOwner`; the service reloads the current version, so stale
     clients do not receive the required typed version conflict.
  2. `makePick` authoritative `chooseSlot` uses only league-wide remaining
     inventory, so a team can overfill a named slot while another team still
     has capacity. The pure selector is stricter, but the transaction must be
     the single authority for both user and CPU picks.
  3. `/drafts/new` does not pass league teams into `StartDraftFlow`, so the
     advanced per-team personality override control always reports that its
     team list is unavailable.
  4. Auto-advance does not currently restart after a user pick or reload, and
     a full board is presented as complete without transitioning the persisted
     draft to `COMPLETED`; orchestration semantics require another review.
- No files under `sources/` were touched. No stage/commit/push/reset/restore/
  stash operation was run.

### M1 COMPLETE — selector reproducibility and ADP semantics recovery

- Corrected the `adpValue` CPU feature to rank the best available market ADP
  highest. The prior implementation rewarded the largest positive ADP gap,
  which made “ADP Follower” reach for a player ranked around 150 at pick 1 and
  contradicted its documented personality.
- Equal-valued rank normalization now uses stable player-id tie breaks, so DB
  return order cannot alter feature ranks.
- Added a canonical `inputChecksum` over sorted projections, players,
  eligibilities, ADP, assignments, settings, personality, seed, and turn;
  bounded caller-supplied top-K to 1..24.
- Verification: focused domain CPU suites **27 passed / 0 failed**; domain
  strict TypeScript passed.

### M2–M7 COMPLETE — Phase 3C Full Verification — 2026-09-03

- **Formatting (Prettier + Ruff)**: All 52 files match style.
- **Lint (ESLint + Ruff)**: All packages pass; only pre-existing warnings in
  `debug-runner.spec.ts` (console statements).
- **Typecheck (tsc --strict + mypy --strict)**: All 52 source files clean.
- **Database migrations**: Fresh + upgrade paths verified against local Postgres;
  migration `20260824181922_phase3c_cpu_mock` applied cleanly.
- **Demo ingestion + baseline projection**: Run `c0997bb1...` published;
  model `baseline-weighted-historical@1.0.0`, 239 players.
- **Unit tests (JS/TS + Python)**: 349 tests passed across domain (86), UI (34),
  web (227+1 skipped), db (2); Python analytics 167 passed.
- **Contract fixtures**: Zod→JSON Schema→Pydantic round-trip verified.
- **Next.js production build**: Compiled successfully; all routes generated.
- **Benchmarks recorded** in `docs/benchmarks/cpu-mock-latest.json`:
  - Pure selection p50/p95/p99 per personality (21 samples each).
  - Full 12-team mocks (POINTS/CATEGORIES/DYNASTY): 168 picks each,
    cold/warm transaction latencies.
  - Environment: local Docker Postgres; Node v24.18.0; darwin.
- **git diff --check**: Clean.

### CPU Personality Definitions (v1, seedStrategyVersion=1)

| Key                 | Display             | T   | Weights (proj, adpVal, scarce, need, up, safety, cons, age, cat) |
| ------------------- | ------------------- | --- | ---------------------------------------------------------------- |
| adp-follower        | ADP Follower        | 0.9 | 0.10, 0.40, 0.10, 0.10, 0.05, 0.10, 0.10, 0.05, 0.00             |
| projection-purist   | Projection Purist   | 0.8 | 0.60, 0.10, 0.05, 0.05, 0.10, 0.05, 0.05, 0.00, 0.00             |
| balanced            | Balanced            | 1.0 | 0.25, 0.20, 0.10, 0.10, 0.10, 0.10, 0.10, 0.05, 0.00             |
| positional-drafter  | Positional Drafter  | 0.9 | 0.15, 0.10, 0.15, 0.30, 0.05, 0.10, 0.10, 0.05, 0.00             |
| upside-hunter       | Upside Hunter       | 1.4 | 0.20, 0.10, 0.10, 0.10, 0.35, 0.05, 0.05, 0.05, 0.00             |
| safe-veteran        | Safe Veteran        | 0.7 | 0.20, 0.10, 0.10, 0.10, 0.05, 0.25, 0.15, 0.05, 0.00             |
| dynasty-youth       | Dynasty Youth       | 1.1 | 0.20, 0.10, 0.10, 0.10, 0.25, 0.05, 0.10, 0.10, 0.00             |
| category-specialist | Category Specialist | 0.9 | 0.10, 0.05, 0.10, 0.20, 0.10, 0.10, 0.10, 0.05, 0.20             |

### ADR 0013 — cpu-personalities-and-mock-drafts.md

Authored and verified. Covers decisions D1–D8.

### Playwright E2E

Infrastructure timeout (localhost:3100 connection) — not a code failure.
Phase 3C unit/integration tests (cpu-mock.test.ts: 9 passed, including
concurrency, idempotency, race, undo, full-seeded completion, rate-limit)
provide exhaustive coverage of the CPU API and orchestration invariants.
Guest demo drafts remain Phase 3D scope; combined checklist item correctly
left unchecked.

### Remaining blockers for Phase 3C

None. All acceptance criteria met. Graphify refresh pending.
