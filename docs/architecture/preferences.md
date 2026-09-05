# Preference profiles — architecture, API, and methodology (Phase 3A)

Source of truth: BUILD_SPEC.md §2.2/§4.2 and docs/adr/0011. This page documents
what Phase 3A shipped: domain contracts, persistence, owner-scoped APIs, the
`/preferences` experience, and the normalization/preset methodology.

## Domain model

```
User 1───* UserPreferenceProfile 1───* PreferencePlayer *───1 Player
                                  1───* PreferenceTeam   *───1 NbaTeam
User 1───* CustomPlayerRank *───1 Player
User 1───* CustomPlayerRank *───0..1 League      (NULL league = global board)
```

- `user_preference_profiles`: `ownerId`, unique `(ownerId, name)`, at most one
  `isDefault` per owner (partial unique index), `presetKey`/`presetVersion`
  provenance, `settingsJson` validated against
  `PREFERENCE_SCHEMA_VERSION = 1`.
- `preference_players`: unique `(profileId, playerId, listType)`; magnitude is
  a precise `DECIMAL(4,3)` whose sign must match the list type.
- `preference_teams`: unique `(profileId, teamId)`, FAVORITE/DISLIKED only.
- `custom_player_ranks`: dense ranks per scope; global scope (`leagueId IS
NULL`) uniqueness enforced by partial indexes; league deletion cascades its
  scoped ranks only.

Settings envelope (v1): `factorWeights` (11 engine factors, exact sum 1),
`lockedFactors`, `riskTolerance`, `upsidePriority`, `youthBias`,
`roleMinutesPriority`, `schedule {enabled, playoffWeeks}`,
`positionPriorities`, `categoryPriorities` (+ explicit `puntStats`),
`avoidMode` (`EXCLUDE | SEVERE_PENALTY`).

## Normalization methodology

1. **Reciprocal-rank defaults** — a strategy orders all eleven factors; raw
   weight for rank r is `1/r`; raw values normalize to sum 1. The default
   priority is exactly BUILD_SPEC §2.2's ordering.
2. **Locked-slider renormalization** — locked factors keep their stored values
   bit-exactly; unlocked factors share the remaining mass proportionally to
   their previous shares (uniform split if all were zero). If locked factors
   exceed 100% an actionable error names the fix ("unlock or lower a slider").
3. **Exactness** — values are rounded to 6 decimals with largest-remainder
   distribution (ties broken by factor key), so stored decimals total exactly
   1.000000; float summation may differ by ≤1e-15 and tests assert at integer
   unit scale.

## Presets

Thirteen versioned definitions live in `packages/domain/src/preferences.ts`
(`balanced`, `bpa`, `positional-balance`, `win-now`, `dynasty-youth`,
`high-upside`, `low-risk`, `guard-heavy`, `big-man-build`,
`threes-and-scoring`, `defensive-categories`, `punt-strategy`,
`schedule-optimizer`). Each carries a stable key, version, title,
plain-language explanation, and optional factor priority / overrides / locks /
scalars / categories / punts. Applying one produces COMPLETE editable settings
(never an opaque mode) via `applyPreset()`. The UI renders the same data —
there are zero preset conditionals in components.

## APIs

All routes require authentication; ownership scoping makes foreign ids
indistinguishable from missing ids (404). Mutations share a Postgres-backed
rate limit (30 changes/min/user → 429 `/problems/rate-limited`) and write
redacted audit rows (`preference.*`, counts only — no note text, no Clerk ids).

| Method           | Path                              | Notes                                                                                                                  |
| ---------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET              | `/api/v1/preference-profiles`     | own list, default first, cursor pagination                                                                             |
| POST             | `/api/v1/preference-profiles`     | from `preset.key` or explicit settings; name conflicts → 409                                                           |
| GET/PATCH/DELETE | `/api/v1/preference-profiles/:id` | PATCH replaces settings and/or lists transactionally; DELETE promotes newest remaining profile                         |
| GET              | `/api/v1/custom-ranks?leagueId=`  | ordered board for one scope                                                                                            |
| PUT              | `/api/v1/custom-ranks`            | full-scope replacement; ranks must be a duplicate-free permutation of 1..N over known non-retired players; P2002 → 409 |
| GET              | `/api/v1/teams?q=`                | team metadata lookup for the editor                                                                                    |

Validation failures use the shared 422 problem shape with field-level errors;
stored settings are re-validated on every read.

## Scope honesty

Phase 3A shipped the foundation. Phase 3B (below) attached immutable draft
snapshots and wired the engine.

## Phase 3B — immutable snapshots, override resolution, recommendations

ADR 0012 is the decision record; this section documents what shipped.

### Snapshot model

Every started draft captures ONE `DraftPreferenceSnapshot` (versioned JSON,
`snapshotVersion = 1`) inside the authoritative `DRAFT_STARTED` transaction:

```
League 1───0..1 PreferenceProfile (preferredProfileId, ON DELETE SET NULL)
Draft  1───0..1 PreferenceProfile (overrideProfileId,   ON DELETE SET NULL)
Draft  *───self-contained preferenceSnapshot JSONB + version + checksum
                                   + preferenceSourceProfileId (provenance)
```

- Override precedence: explicit draft override → league selection → user
  default profile → versioned DraftCourt defaults.
- Resolution happens once, inside the locked start transaction; foreign or
  deleted profile ids fall through to the next precedence level exactly like a
  missing id (no enumeration oracle).
- The snapshot stores complete normalized settings, signed player/team entries,
  BOTH custom-rank scopes (league overrides global when projected), provenance
  labels copied at capture, and a server-supplied `capturedAt` that is excluded
  from the checksum — identical strategy content always hashes identically.
- Picks, undo, pause/resume, reload, replay, recalculation, and profile edits
  never rewrite it. Deleting a source profile cannot invalidate it.

### Recommendation integration

The orchestration layer projects the stored snapshot into
`EngineInput.preferences`; because that key participates in the canonical
checksum, different snapshots can never share cached rows while unchanged
inputs stay idempotent (`(draftId, sequence, inputChecksum)` upsert). Legacy
Phase 2 drafts (no snapshot) reproduce their recorded behavior byte-for-byte;
the early cache guard additionally requires stored row engineVersion ===
draft.engineVersion, and new drafts stamp the domain-owned constant so the two
can never drift. Malformed stored snapshots make recommendations fail closed
rather than recompute against the wrong strategy.

Formulas, bounds, warnings, and worked semantics: docs/recommendation-engine.md
(§ Personalization) and ADR 0012. Engine version:
`phase3-preferences-1.0.0`.

### APIs added

| Method | Path                                   | Notes                                                                                                      |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| PATCH  | `/api/v1/leagues/:id`                  | meta body gains `preferredProfileId: uuid \| null`; owner-validated, foreign id → 404                      |
| GET    | `/api/v1/leagues/:id`                  | detail gains `strategySelection` view                                                                      |
| GET    | `/api/v1/leagues/:id/strategy-preview` | resolved preview (`?overrideProfileId=` previews an override); never persists                              |
| POST   | `/api/v1/drafts`                       | create body gains optional owner-validated `overrideProfileId`                                             |
| GET    | `/api/v1/drafts/:id`                   | read model gains `strategy` evidence (status OK/INVALID, provenance, versions, checksum, settings summary) |

Invalid stored settings fail closed at start with 422
`/problems/invalid-strategy`, BEFORE any DRAFT_STARTED event exists.

### Security notes

- All selection/preview routes are authenticated and owner-scoped; foreign ids
  are indistinguishable from missing ones on every path (leagues, overrides,
  previews, resolution fallback).
- Snapshot checksums are content-addressed (SHA-256 over canonical form minus
  time/provenance labels); they are integrity evidence, not secrets.
- Audit coverage: league selection changes flow through the existing redacted
  league PATCH audit path; preference mutations keep their Phase 3A rate limit
  (30/min/user).
- Concurrency: snapshot capture rides the draft row's `SELECT … FOR UPDATE`;
  a second concurrent start observes the new status and fails without writing.

### ERD delta

See docs/architecture/erd.md § "Phase 3B preference snapshot columns".
