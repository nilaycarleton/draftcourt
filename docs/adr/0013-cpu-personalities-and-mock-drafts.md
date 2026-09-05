# ADR 0013: Deterministic CPU personalities and authenticated mock drafts

- Status: accepted
- Date: 2026-08-24
- Phase: 3C — CPU personalities and authenticated mock drafts

## Context

BUILD_SPEC §11 requires eight versioned CPU personalities (weight vector +
temperature) whose seeded selection is reproducible, reuses the production
draft transaction without a separate correctness model, and never bypasses
legality. Open questions: reuse the recommendation engine per pick vs a
dedicated feature pass; where seeds come from; how personality identity
survives history; how CPU picks enter the single authoritative transaction.

## Decision

### Features from raw inputs, not engine outputs

CPU scoring computes nine normalized [0,1] features (projection, adpValue,
scarcityFit, rosterNeed, upside, safety, consistency, ageCurve,
categoryEmphasis) directly from projections/meta/ADP/settings through the same
exported value primitives the engine uses (`seasonFantasyPoints`,
`categoryUtility`, pool baselines, percentiles) plus three parity formulas that
are golden-tested against their engine originals. Calling `recommend()` per CPU
pick was rejected: its availability simulation and lookahead are expensive at
~130 picks per mock, its horizon semantics are user-slot-relative, and engine
outputs are cache-addressed artifacts. Consequence: `ENGINE_VERSION` bumps do
not silently change CPU behavior; the seed derivation has its own frozen
`seedStrategyVersion`.

### Immutable personality snapshots on teams

Each non-user team of an authenticated MOCK draft receives, at creation, one
immutable `CpuPersonalitySnapshot` JSON (key, version, display label,
description, full weight vector summing to 1 at 6-decimal precision,
temperature in [0.4, 1.6], seedStrategyVersion). Historical reproduction never
depends on runtime definitions; stored snapshots fail closed on unknown
versions, exactly like preference snapshots (ADR 0012 discipline). The legacy
`cpuStrategy` varchar carries the key for cheap display.

### Seeds derive from persisted state only

A draft-level `simulationSeed` (user-supplied reproducibility code or server
random, immutable after creation) hashes into a uint32 draftSeed. Each decision
derives `pickSeed = SHA-256(canonical{seedStrategyVersion, draftSeed,
personalityKey+version, teamSlot, nextOverallPick})`. Selection spends exactly
one seeded softmax draw over the top-K candidates under a stable total order.
Undo restores identical effective state, so re-advancing reproduces the same
player; reloads and replays cannot drift because nothing consults wall-clock
or mutable random state.

### One transaction path for everyone

`makePick` gains an internal optional CPU decision provider; the provider runs
inside the existing locked transaction so decisions see authoritative state.
Every guarantee is shared code: row lock, If-Match version validation,
duplicate-delivery idempotent replay, availability and roster legality
(league-wide + team-level slot accounting), retired/unsigned policy, event
append with read-model update, outbox-driven recommendation refresh, optimistic
version bump, compensating undo. CPU events carry explicit evidence in payload
(`cpu:true`, personality key/version, seed-strategy version, decision seed hex,
decision checksum, bounded selection score) — actor status is never inferred
from a missing user id. The API takes no player or team input at all: the
picking team derives from the authoritative cursor, making arbitrary-player
injection structurally impossible.

### Owner-paced orchestration

One CPU pick per authenticated owner request (`POST /api/v1/drafts/:id/cpu-pick`);
batching was rejected as complexity without benefit — the client paces
sequential requests at slow/normal/instant presentation speeds that change
timing only, never selections. Auto-advance loops client-side and always stops
at the user's turn derived from fresh server state; cancel/pause are runner
states; reload rebuilds everything from persisted data. Pacing preferences live
in localStorage; outcome-relevant state lives only in the database.

## Consequences

- Real drafts gain no CPU surface (columns nullable, creation path gates on type).
- Guest demos remain future scope; personalities declare supported modes so the
  same domain serves them later without redefinition.
- Operators reproduce any mock from `{simulationSeed, league settings,
projection run, personality snapshots}` alone.

## Verification

Domain golden/property suites (determinism, divergence, temperature
monotonicity, legality, undo stability, bounds), DB-backed concurrency and
security tests (single-winner races, enumeration resistance, typed conflicts,
event evidence), full seeded completion e2e including same-seed sequence
equality, and benchmarks recorded under docs/benchmarks/.
