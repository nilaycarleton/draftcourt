# ADR 0016: Deterministic Draft Replay and Private Result Sharing

- Status: accepted
- Date: 2026-09-07
- Phase: 3E2 — replay timeline/UI, private share capabilities, redacted public view, revocation/expiration/cleanup

## Context

Phase 3E1 shipped owner history and deterministic analysis (ADR 0015) but deferred
replay and sharing. BUILD_SPEC requires: immutable event replay (§4.4, §9.4),
revocable unguessable read-only result links for completed drafts (§2.1, §8.2,
§13), 256-bit share tokens with hash-only storage (§13), rate limits, redaction,
`noindex`, and no live spectators. The existing `Draft.shareTokenHash` column has
no write path; the events API has no pagination; `replayFromEvents` has no
sequence slicing, checksums, or typed failures.

Key questions: replay architecture without a second interpretation, historical
payload compatibility, token/digest design, TTL (unspecified by BUILD_SPEC),
revocation/expiration semantics, rate-limit dimensions behind a proxy, redaction
boundaries, and cleanup isolation.

## Decision

### R1 — Replay is a pure sequence-sliced reduction (no second interpretation)

- New pure module `packages/domain/src/replay.ts`, version `REPLAY_VERSION =
"1.0.0"`, no I/O, no wall-clock, no network/DB.
- `replayToSequence(events, teamCount, uptoSequence)` replays sorted events
  `sequence <= uptoSequence`; `replayFull` replays all. Final-state output is
  byte-equal to `draft.ts:replayFromEvents` for the same input (differential
  test enforces; no divergent second interpretation).
- Snake numbering: `overallPick` counts effective `PLAYER_DRAFTED` selections
  only (keepers included, undone excluded); `round = ceil(op/teamCount)`,
  `pickInRound = ((op-1) % teamCount)+1`, `slot = overallPickToSlot(op,
teamCount)` is informational (authoritative slot is the stored `teamSlot`).
- Undo: `PICK_UNDONE.causationEventId` must reference an earlier effective
  `PLAYER_DRAFTED`; replay removes that selection and decrements the cursor.
  Undo-after-new-pick (alternate history) replays correctly because the undone
  set is computed from events `<= uptoSequence` only.
- Bounded: rejects inputs over `MAX_REPLAY_EVENTS = 5000` with typed failure.
- Checksum: `replayChecksum(state)` = SHA-256 over canonicalized
  `{ selections: [{playerId, teamSlot, slotPosition, overallPick, isKeeper}],
nextOverallPick, currentSequence }` (sorted by overallPick). Stable across
  platforms; recorded in benchmarks.

### R2 — Historical compatibility policy

- All six accepted event types and all observed payload versions (keeper flag,
  CPU evidence, preference snapshot evidence, empty lifecycle payloads) replay
  deterministically. Old rows are never rewritten or normalized in place.
- Unknown event types: preserved as timeline markers when they cannot change
  roster state (e.g. future pause-like markers); replay fails closed with
  `UNKNOWN_STATE_CHANGING_EVENT` when an unknown type carries `playerId`,
  `teamSlot`, or `causationEventId`.
- Malformed rows (non-integer sequence, gaps, duplicate sequences, duplicate
  effective players, undo referencing missing/already-undone picks, illegal
  slot strings) return typed `ReplayError` with stable `code`; callers render
  `integrity: FAIL` and never present the state as trustworthy. Keeper picks
  replay like any other pick; keeper-undo protection lives in the draft
  transaction layer (which refuses keepers as undo targets), not in the
  reducer.

### R3 — Event timeline API (backwards-compatible)

- `GET /api/v1/drafts/:id/events` stays owner-only with enumeration-resistant
  `404`. Without query params it returns the legacy array (existing callers
  unchanged). With `?cursor=&limit=` it returns `{ events, nextCursor,
integrity }`: strict cursor (integer sequence)/limit (1–100) validation,
  ascending order, sequence-keyed cursor (no gaps/duplicates), per-event
  `actorType` (USER/CPU/SYSTEM), safe `description`, undo linkage, CPU evidence
  subset, and `verifyReplayIntegrity` status. No credentials, no raw internals,
  redacted observability.

### R4 — Share capability model

- New table `draft_share_capabilities`: `id UUID7, draftId UNIQUE (one active
row per draft), tokenDigest UNIQUE (SHA-256 hex), createdAt, expiresAt,
revokedAt NULL, lastAccessedAt NULL, version INT`. FK `draftId → drafts(id)
ON DELETE CASCADE`. Partial index `expiresAt WHERE revokedAt IS NULL`.
- Token: 32 CSPRNG bytes → base64url 43 chars (256-bit, same alphabet as demo
  tokens; never reused as guest tokens). Digest: hex SHA-256 of the raw token;
  constant-time `timingSafeEqual` on Buffer comparison. Raw token returned
  exactly once (in `POST` response `shareUrl`); never stored, logged, audited,
  or cached.
- Only `COMPLETED` `REAL`/`MOCK` drafts may be shared; `DEMO` and incomplete
  drafts fail with owner-safe errors (foreign drafts 404, own incomplete 409).
- Rotation: `POST` when a row exists creates version+1 with a fresh token and
  immediately invalidates the old digest (single winner under the
  `draftId UNIQUE` guard; `P2002` → re-read winner). `DELETE` sets `revokedAt`
  (idempotent; second delete is still 200 with `revoked:false`).
- Legacy `Draft.shareTokenHash` is left NULL/untouched (no backfill; no
  accidental sharing).

### R5 — TTL, revocation, expiration (BUILD_SPEC defines no share TTL)

- BUILD_SPEC fixes demo expiry (24h) but no share TTL; this ADR sets an
  explicit **90-day TTL** from creation. Rationale: long enough for offseason
  review, short enough to bound leakage; revocation covers immediate needs.
- `expiresAt` enforced server-side on every public lookup (client time never
  authoritative). `revokedAt` invalidates immediately. Expired/revoked/invalid
  all return identical `404` (no oracle) with identical work shape.
- Cleanup (`lib/server/share-cleanup.ts`): advisory-locked, batch-100,
  idempotent; deletes share rows with `expiresAt < now()` or `revokedAt <
now()-7d`; never touches drafts/analyses/events/history/demo rows; safe
  concurrently with reads; reports redacted counts + timing only.

### R6 — Public redacted view

- `GET /share/[token]` (path segment, never query string): token-format check
  → digest → single lookup with `revokedAt IS NULL AND expiresAt > now()` →
  draft must be `COMPLETED` → redacted DTO (safe title label, league
  type/horizon/dimensions, board, team display names, rosters, grade +
  approved breakdowns, round value, strengths/weaknesses, standings, version +
  freshness + synthetic-baseline + no-guarantee disclosures, read-only replay
  from the redacted event DTO).
- Headers: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, noarchive`,
  `Cache-Control: private, no-store`, `<meta name="robots"
content="noindex,noarchive">`, no third-party referrer receivers. Known nuance
  (verified in E2E): Next.js embeds the visited path segment in RSC
  flight/router state (address-bar equivalent), so leak controls target
  rendered text, console, error/network payloads, third-party requests, logs,
  audit, analytics, and Sentry — all proven clean by unit + E2E scans.
- States: loading / valid / valid-partial / revoked-expired-invalid (single
  indistinguishable 404 unless spec permits distinction — it does not) /
  analysis-unavailable / integrity-failure / rate-limited. Owner result
  unchanged by sharing or revocation; analysis never regenerated by replay or
  sharing.

### R7 — Rate limits and redaction

- `share:create` 10/h per user, `share:revoke` 30/h per user, `share:lookup`
  60/m per hashed IP, `share:tokenFailure` 10/5m per hashed IP (hashed
  `SHA-256(ip|ua)`, never raw IP). Redis fixed-window + Postgres audit_log
  fallback (demo pattern). 429 without validity signal.
- Audit rows for create/revoke contain `{ draftId, version, expiresAt }` only.
  Application logs, DB logs, Sentry, analytics, and error payloads never
  contain raw tokens, digests, emails, owner/Clerk IDs, or capability material.
  `scrubSentryEvent` extended for `shareToken|shareDigest|capabilityToken` and
  share-path segments.

## Consequences

- Any `{ordered events, teamCount, uptoSequence}` reproduces byte-identical
  replay state + checksum; integrity failures are visible, never silent.
- One active share per draft; rotation/revocation/expiry are immediate and
  unambiguous; cleanup cannot delete product data.
- Public shares are isolated from Clerk/demo/ownership and reveal exactly one
  completed result in redacted form.

## Verification

- Replay domain golden/unit/property tests (determinism, checksums, undo +
  alternate history, keeper/CPU/system, unknown-safe vs unknown-unsafe,
  malformed typed failures, bounds, integrity visibility, no
  duplicate/illegal states, Phase 2/3 fixture compatibility).
- Share token/security tests (entropy, digest-only, no-leak scans, owner
  isolation, enumeration resistance, DEMO/incomplete rejection, single-result
  scope, invalid/revoked/rotated/expired safety, read-only, capability
  non-interchange, concurrency winners, cleanup isolation, rate limits without
  oracle, DTO allowlist).
- Integration (history→result→replay, filter/pagination stability,
  checksum/version stability, share-without-analysis-mutation,
  revoke-without-owner-effect, post-undo consistency, mock/demo regression,
  fresh + upgrade migrations).
- Playwright (authenticated + signed-out, keyboard, focus, axe, 320px/200%,
  themes, reduced motion, long names, overflow, no token in console/network).
