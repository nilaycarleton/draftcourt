# ADR 0010: Phase 2 — event-sourced draft core, deterministic recommendations, and design workflow

- Status: accepted
- Date: 2026-08-22
- Phase: 2 — league setup and live draft core

## Context

Phase 2 requires (BUILD_SPEC.md sections 4.2/4.4, scope items 1–7): league
persistence with immutable settings versions, an event-sourced draft core with
optimistic concurrency, a deterministic recommendation engine with seeded
availability simulation and shallow lookahead, and the Impeccable design
workflow applied to the wizard and live room.

## Decision

### League settings are immutable version chains

`LeagueSettingsVersion` rows are write-once. Editing rules creates version N+1
and repoints `League.activeSettingsVersionId` inside one transaction that also
re-checks "no draft exists" under the row lock — so a draft created
concurrently cannot slip past immutability. Type/horizon/playoffWeeks move in
the same transaction as their owning version. `LeagueTeam`, `RosterSlotRule`
and `ScoringRule` rows expand presets into persisted custom configuration.
Hand-added CHECK constraints (ADR 0005 pattern) enforce team count 4–20,
slot ≤ teams, rounds ≥ 1, roster counts ≥ 0 and weight bounds at the database.

### The draft is an append-only log plus a materialized read model

Every mutation (`makePick`, `undoPick`, `transitionStatus`) is ONE Postgres
transaction that locks the draft row (`SELECT … FOR UPDATE`), validates status
and optimistic `version` (client `If-Match`), appends an immutable event
(unique `(draftId, sequence)` + `(draftId, idempotencyKey)`), maintains
`DraftRosterAssignment` (unique `(draftId, playerId)` = at most one EFFECTIVE
selection per player), advances/reverses the snake cursor, increments
`version`, and writes a recommendation outbox row. Undo appends a compensating
`PICK_UNDONE` referencing `causationEventId`; events are never deleted or
rewritten. Duplicate deliveries replay the recorded outcome. 409 responses
carry the authoritative state so clients reconcile without a second read.

Keeper retentions enter as explicit immutable `PLAYER_DRAFTED` pre-draft
events (payload `{keeper:true}`) appended at draft creation before
`DRAFT_STARTED` — real cursor + roster effects from the start, never hidden
mutations. Phase 2 restricts undo to the LATEST effective pick; keeper events
are excluded as undo targets.

Snake math lives in `packages/domain/src/draft.ts`
(`overallPickToSlot/Round/PickInRound`, `upcomingPicksForSlot`) with
property-based tests for 4–20 teams, every round/slot, inverse decomposition,
and replay determinism (`replayFromEvents`). A production integrity check
(`verifyReplayIntegrity`) rebuilds state purely from events and compares it to
stored materialized rows — this backs the replay-divergence runbook.

### Slot legality and multi-position matching

Slot resolution prefers specific eligible starter slots (league-wide capacity
= per-team count × teamCount), then UTIL, then BENCH
(`candidateSlotsForEligibility` order). The benchmark harness caught a real
defect here early on (comparing league-wide fills against a single team's
count); fixed and regression-covered by the pick flow tests.

### Deterministic engine (packages/domain/src/recommendation.ts)

Pure functions only. Canonical JSON serialization (sorted keys,
array-order-stable) → synchronous SHA-256 → input checksum stored on every
snapshot; simulation seeds derive from checksum + explicit engine seed (never
wall-clock). Components follow section 6 exactly:

- **production**: points leagues blend 0.65×percentile(per-game FP) +
  0.35×percentile(season FP); categories use replacement-relative utility with
  reliability √(games/82) and LOWER_BETTER sign flips; FG%/FT% use volume-aware
  impact z-scores (FGM − baseline%×FGA), never averaged percentages.
- **scarcity**: marginal value above positional replacement, UTIL/BENCH ×0.7.
- **rosterNeed**: required-slot coverage + logistic category win-probability
  with diminishing returns decaying toward the 0.85 ceiling; punts contribute 0.
- **risk / consistency / upside / role**: absolute 0–1 semantic scores from
  projection intervals, injury risk, consistency and role security fields —
  deliberately NOT rank-normalized (a uniformly healthy pool must not produce
  artificial spread).
- **age**: neutral in redraft; youth curve for keeper/dynasty.
- **adpValue**: bounded gap percentile with LOW confidence when sources < 2.
- **preference**: default profile contributes 0 in Phase 2 (cap documented);
  **schedule**: off by default.
- **nextPickAvailability**: 250-run live Monte Carlo; intervening opponents
  sample a softmax over ADP, projected utility and a minimal versioned
  tendency vector updated from observed real picks (no user profiles created).
- **lookahead**: top-20 shallow two-user-pick rollout capped at 10%.

Final score `100 × clamp(base + 0.10×lookahead)`, ties broken by production →
scarcity → adpValue → stable player ID. Labels (Best Overall/Fit/Value/Highest
Upside/Safest Pick) and explanations come from deterministic templates using
the two largest positive contributions and the largest material caveat.

Snapshots persist by unique `(draftId, sequence, inputChecksum)` — identical
inputs upsert in place rather than duplicating; no stale cache can ever touch
pick legality because legality is enforced transactionally against live tables.
The outbox row written in the pick transaction is marked processed when
recommendations for that sequence exist (self-healing sweep on read).

### Impeccable workflow

Project-scoped OpenCode install verified; `PRODUCT.md` classifies DraftCourt
as an Operate-mode product dashboard/tool; `DESIGN.md` records the accepted
world reconciled with BUILD_SPEC §10/ADR 0003 (spec wins). The accepted shape
lives in docs/design/phase2-shape.md: information hierarchy, court-line
signature motif, desktop/mobile transformations, keyboard/focus model, all
required states, reduced-motion/transparency/high-contrast/screen-reader/zoom
behavior. Implementation uses `@draftcourt/ui` tokens + Astryx primitives +
Motion; no second component system; Anime.js stays out of the live path.

## Consequences

- Verified end-to-end against the real demo dataset: 230-player pool,
  byte-deterministic outputs, cached-by-checksum reads, outbox self-healing.
- Benchmarks (docs/benchmarks/recommendations-latest.json): cold p95 ≈ 156 ms
  and warm p95 ≈ 9 ms on the 12×16 fixture — inside section 6.9 budgets.
- Known Phase 2 limits, honestly scoped: CPU picks, preference profiles,
  grades/sharing remain Phase 3; recalculation rate limiting is Postgres-based
  (4/30s per draft), Redis remains optional acceleration only.
