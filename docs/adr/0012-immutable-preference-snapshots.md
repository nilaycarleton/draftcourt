# ADR 0012: Immutable draft preference snapshots and override resolution

- Status: accepted
- Date: 2026-08-24
- Phase: 3B — preference snapshot and recommendation integration

## Context

Phase 3A delivered owner-scoped preference profiles (ADR 0011) but nothing
consumed them. Phase 3B must connect profiles to recommendations while
preserving the Phase 2 invariants: byte-reproducible recommendations, immutable
historical snapshots, and cache identity by input checksum
(ADR 0010). The open questions were where override selection lives, how a
started draft becomes immune to later profile edits, and how personalization
enters the pure engine without changing historical behavior.

## Decision

### One immutable snapshot per started draft, captured at start

`transitionStatus("start")` resolves the effective strategy INSIDE its existing
`SELECT … FOR UPDATE` transaction and stores a self-contained versioned JSON
snapshot on the draft row (`preferenceSnapshot`, `preferenceSnapshotVersion`,
`preferenceSnapshotChecksum`, `preferenceSourceProfileId`), in the same
transaction as the `DRAFT_STARTED` event. Picks, undo, pause/resume, reload,
replay, recalculation, and profile edits never rewrite it. Recommendation
orchestration reads ONLY this stored snapshot — never live profile tables.

### Override precedence

1. explicit draft override (`Draft.overrideProfileId`),
2. league selection (`League.preferredProfileId`),
3. user default profile,
4. versioned DraftCourt defaults.

Both selection columns are nullable FKs to `user_preference_profiles`
`ON DELETE SET NULL`: deleting a profile clears pending selections cleanly (no
dangling ids), while started drafts are unaffected because their snapshots are
copied JSON. Foreign/stale ids resolve as not-found at selection time
(owner-validated), preserving the no-enumeration-oracle rule.

The snapshot records non-binding provenance (`source.kind`, `profileId`,
safe display name captured at start, preset key/version). League-scoped custom
ranks override global ranks for the same player; both scopes are stored and the
engine receives the resolved merge.

### Checksums exclude time; content-addressed identity

`capturedAt` is server-supplied and excluded from both engine math and the
snapshot checksum (`SHA-256` over the canonical form of everything else). Two
snapshots with identical strategy content hash identically regardless of when
they were captured. The engine's canonical input gains one optional
`preferences` entry that serializes to nothing when absent, so Phase 2 inputs
reproduce Phase 2 checksums bit-for-bit and old drafts keep serving their
stored payloads under the existing early-cache guard (row engineVersion ===
draft.engineVersion). New drafts stamp the current engine version imported from
the domain package (removing the duplicated private constant), keeping warm
cache hits intact after the bump.

### Bounded deterministic personalization

When preferences are present every modulation is gated so absent-preference
paths run the Phase 2 code verbatim. Factor weights come from the snapshot;
scalars spread/attenuate risk/upside/age/role around neutral centers that
exactly equal the legacy defaults; list/team/rank terms sum into the single
`preference` component clamped to [-1, 1] with its contribution hard-capped at
±10 score points. Hard avoids exclude players by default with an actionable
severe-penalty fallback if exclusion would empty the eligible pool; targets can
never bypass legality; punts stay explicit; missing schedule data stays an
honestly-labeled neutral signal. Engine version bumps to
`phase3-preferences-1.0.0`; old payloads remain readable through their own
recorded versions.

## Consequences

- Profile edits affect only future drafts — the product claim "your saved
  strategy applies to new drafts" is enforced by dataflow, not discipline.
- Historical replay/reproducibility is unchanged: old recommendation rows are
  never rewritten (upsert update branch touches only latency/requestedAt).
- Adding snapshot fields later means bumping `snapshotVersion` and extending
  the zod schema + read validation; unknown versions fail closed.
- Cache identity automatically includes preference provenance because the
  snapshot participates in the engine input checksum.

## Verification

Domain golden/property tests (byte-equality without preferences; bounds;
monotonic ranks; avoid fallback), DB-backed persistence/immutability tests,
API ownership tests, authenticated Playwright flow (edit profile → active
draft unchanged → new draft receives edit), and benchmarks recorded under
`docs/benchmarks/`.
