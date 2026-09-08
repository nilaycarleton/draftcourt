# Phase 3E2 Recovery Checkpoint — Draft Replay, Event Timeline, Private Result Sharing

**Last updated:** 2026-09-07T00:00:00Z
**Starting commit:** `e622cd1ed6b03beae7d0b70195aa7ecb0aafb820` (`feat: add draft history and deterministic analysis`)
**Phase:** 3E2 — replay reducer, owner timeline, replay UI, share capabilities, redacted public view, revocation/expiration/cleanup
**Owner:** primary agent only (this file)

## 1. Starting state (verified from source, not screenshots)

- `git rev-parse HEAD` → `e622cd1ed6b03beae7d0b70195aa7ecb0aafb820`
- `git status --short` (initial):
  - `?? PHASE_3_OPENCODE_PROMPT.md`
  - `?? apps/web/scripts/repair-demo-eligibilities.ts`
  - `?? apps/web/tests/e2e/debug-runner.spec.ts`
- Preserved: the three untracked files above are intentionally untracked; do not stage/delete/rewrite without explicit justification.
- Phase 3E1 baseline (verified):
  - `DraftAnalysis` append-only, version `1.0.0`, SHA-256 canonical checksums, 2000-run seeded synthetic baselines (ADR 0015).
  - `GET /api/v1/me/history` owner-scoped cursor pagination, `GET /api/v1/drafts/:id/analysis` idempotent generation.
  - `/history` + `/drafts/[id]/results` owner pages.
  - `Draft.shareTokenHash TEXT NULL` column exists (Phase 2 migration) but has no write/read path; stays NULL (Phase 3D checkpoint confirms guest demos not shareable).
  - No `DraftShare`/share-capability table; no `/share/:token` route; no replay UI beyond `verifyReplayIntegrity`.

## 2. Discovery wave (read-only, source-verified)

### 2.1 DraftEventType and payload shapes (schema.prisma + drafts.ts)

- Enum: `DRAFT_STARTED | PLAYER_DRAFTED | PICK_UNDONE | DRAFT_PAUSED | DRAFT_RESUMED | DRAFT_COMPLETED`.
- `DraftEvent`: `draftId, sequence (unique per draft), eventType, actorUserId?, teamSlot?, playerId?, round?, pickInRound?, causationEventId? (self-FK), idempotencyKey? (unique per draft), payload Json?, createdAt`.
- Payload shapes observed:
  - Keeper `PLAYER_DRAFTED`: `{ keeper: true, season }`.
  - CPU `PLAYER_DRAFTED`: `{ slotPosition, isBench, cpuEvidence: { cpu:true, actorType:"CPU", personalityKey, personalityVersion, seedStrategyVersion, decisionSeed, decisionInputChecksum, decisionChecksum, selectionScore } }`.
  - User `PLAYER_DRAFTED`: `{ slotPosition, isBench }`, `actorUserId` set, no `cpuEvidence`.
  - `DRAFT_STARTED`: `{ preferenceSnapshotVersion, preferenceSnapshotChecksum, strategySource }`.
  - `PICK_UNDONE`: no payload; `causationEventId` → undone `PLAYER_DRAFTED` id, plus `teamSlot/playerId` echo.
  - `DRAFT_PAUSED/RESUMED/COMPLETED`: empty payload.
- `DraftRosterAssignment`: `draftId, eventId UNIQUE, teamSlot, playerId (unique per draft), slotPosition (RosterPosition), isBench, isKeeper, assignedAt`.

### 2.2 Undo semantics

- `PICK_UNDONE` is a compensating event; rows are never deleted except the single `DraftRosterAssignment` row for the undone player (same transaction that appends the undo).
- Only the latest effective non-keeper `PLAYER_DRAFTED` may be undone (server-enforced; `take:10` recent scan + undone-set filter).
- `replayFromEvents` (packages/domain/src/draft.ts) precomputes the undone set, then skips undone picks. Cursor effect is implicit (no explicit reversal). Correct for final state but not sequence-sliced; Phase 3E2 adds `replayToSequence`.

### 2.3 Pause/resume/completion/keeper/CPU/guest/system in timeline

- Pause/resume/completion appear as first-class events and must appear in the timeline as non-pick markers.
- Keepers appear as `PLAYER_DRAFTED` with `keeper:true` before `DRAFT_STARTED`; they consume overall-pick numbers (sequence == overallPick at creation) and are never undo targets.
- CPU evidence lives in `payload.cpuEvidence`; actor must be derived as `CPU` from payload, not from missing `actorUserId` alone.
- Guest/DEMO drafts use capability auth, never appear in history; share must reject `DEMO` and non-`COMPLETED`.
- No other system event types exist; unknown future types must be preserved when safe, fail when state-changing.

### 2.4 Owner-safe vs public-unsafe fields

- Owner-safe (timeline API): sequence, round, pickInRound, teamSlot, playerId + displayName, slotPosition, isBench/isKeeper, actorType (USER/CPU/SYSTEM), causationEventId for undo links, cpuEvidence (personalityKey/version/seed evidence, no secrets), createdAt, integrity status.
- Public-unsafe (never in shared DTO): email, Clerk IDs (`actorUserId`, `clerkUserId`, `ownerId`), guest capability rows/hashes, private notes/preferences/favorites/targets/avoids, custom ranks, audit rows, internal event UUIDs (use sequence instead), recommendation cache internals, raw checksums except truncated display `inputChecksum`, share token/digest, other drafts/history, raw `payload` internals.

### 2.5 verifyReplayIntegrity today

- `lib/server/drafts.ts:verifyReplayIntegrity` rebuilds via `replayFromEvents(log, 12)` with `slotPosition:null, isBench:false`, compares `count(assignments)` vs `replayed.selections.size` and `currentSequence`. Returns `{ ok, detail }`.
- Limitations: teamCount hardcoded 12 (metadata only today), slot/bench evidence ignored, no per-sequence checksums, no typed failure, no exposure through events API. Phase 3E2 fixes all three without changing the accepted function signature.

### 2.6 Board/roster historical rendering

- `getDraftForOwner` returns materialized current view + player names; board component (`packages/ui` DraftBoard) renders from that shape. Historical rendering reuses the same shape by feeding replay-derived assignments at sequence `s` (no live-state mutation).
- `DraftRoom.tsx` must not be rewritten (safety rule); replay UI lives on `/drafts/[id]/results` and the public share page.

### 2.7 Event cursor API sufficiency

- Existing `GET /api/v1/drafts/:id/events` returns the full ordered array with no pagination. Sufficient for small drafts, unbounded for large ones.
- Decision: keep the unpaginated shape for backwards compatibility (existing callers + Playwright `mock-draft.spec.ts` expect an array), and add opt-in cursor pagination (`?cursor=&limit=`) returning `{ events, nextCursor, integrity }` when query params are present. Strict validation, bounded `limit 1..100`, stable ascending order, no gaps/duplicates (sequence-keyed cursor).

### 2.8 Event-count bounds and virtualization

- Standard drafts: 12×14=168 picks + ~5 lifecycle events (<200). Large: 20 teams × 20 rounds = 400 picks. Bounded, but timeline UI still virtualizes/windowing via capped render + `overflow-y:auto` list (no full-DOM for >200 rows) and board renders from replay state (already windowed in DraftBoard).

### 2.9 Token/digest/constraints/expiry/revocation

- Token: 32 bytes CSPRNG → base64url 43 chars (same as demo-tokens, 256-bit). Format regex validated before any crypto.
- Digest: SHA-256 hex of the raw token (fast, one-way; 256-bit input entropy makes rainbow tables infeasible; constant-time `timingSafeEqual` on lookup). PBKDF2 was considered but rejected for the public read path: share lookup is rate-limited and the token already carries 256-bit entropy; SHA-256 keeps p95 lookup <5ms. Algorithm recorded in ADR + benchmarks without secrets.
- Constraints: `draft_share_capabilities(draftId UNIQUE, tokenDigest UNIQUE, expiresAt, revokedAt NULL, createdAt, lastAccessedAt NULL, version INT)`, FK `draftId → drafts(id) ON DELETE CASCADE`, partial index on `expiresAt WHERE revokedAt IS NULL`.
- Expiry: BUILD_SPEC defines no share TTL (only demo 24h). Decision: **90-day TTL** from creation, server-enforced on every lookup, documented in ADR 0016. Rotation creates a new row version (old digest never valid again).
- Revocation: `revokedAt` set by owner DELETE; idempotent; immediate effect (lookup checks `revokedAt IS NULL` inside the same query).

### 2.10 Isolation

- Public share lookup never touches Clerk (`getCurrentUser` not called), never accepts demo capability cookies, never authorizes owner APIs. Share digest and demo token hashes live in separate tables. `DEMO` drafts and non-`COMPLETED` drafts always 404 (no oracle).

### 2.11 Analysis/result redaction

- Shared DTO includes: safe title label (`"Draft results · <season> · <teams> teams × <rounds> rounds"` — never league name which may be private), league type/horizon/teamCount/rounds (no settings internals), final board (overallPick → teamSlot → player displayName + slotPosition), team display names only (no user flags), final rosters, analysis grade + 5 components + round value + strengths/weaknesses + projected standing + version/freshness/disclosure/synthetic-baseline note.
- Excluded: everything in §2.4 unsafe list. Raw `inputChecksum` shown truncated (12 chars) only.

### 2.12 Cleanup

- `runShareCleanupBatch`: advisory lock (`pg_try_advisory_lock`, distinct key from demo cleanup), batch 100, deletes `revokedAt NOT NULL AND revokedAt < now()-7d` OR `expiresAt < now()` share rows only; never touches drafts/analyses/events/history/demo rows. Idempotent, bounded, concurrency-safe with public reads (single-row deletes, no table lock). Reports redacted counts + timing only.

### 2.13 Rate limits (behind proxy: use hashed IP + user id, never raw IP)

- `share:create` 10/h per user; `share:revoke` 30/h per user; `share:lookup` 60/m per hashed IP; `share:tokenFailure` 10/5m per hashed IP. Redis fixed-window with Postgres `audit_log` fallback (same pattern as demo-rate-limit). No validity oracle: invalid/expired/revoked all return identical 404 with identical timing shape (constant work: always hash + lookup + failure counter).

### 2.14 Leakage vectors

- Crawlers: `X-Robots-Tag: noindex, noarchive` + `<meta name="robots" content="noindex,noarchive">`.
- Referrer: `Referrer-Policy: no-referrer` on share pages/APIs; no third-party resources that receive the share URL; no query-string tokens (path segment only).
- Analytics/logs/audit/Sentry: never log raw token, digest, email, ownerId, Clerk ID; audit rows record `{ draftId, version, expiresAt }` only; Sentry `scrubSentryEvent` extended with `shareToken|shareDigest|capabilityToken` keys + URL-path token scrub.
- Cache: `Cache-Control: private, no-store` on share pages and share APIs.

### 2.15 Incomplete/corrupted histories

- Replay fails closed with typed `ReplayError` codes (`EMPTY_OK` is not an error; `MALFORMED_EVENT`, `GAP_IN_SEQUENCE`, `DUPLICATE_PLAYER`, `UNKNOWN_STATE_CHANGING_EVENT`, `ILLEGAL_SLOT`, `CORRUPT_UNDO_REFERENCE`). UI shows actionable error + integrity badge `FAIL`, never presents untrusted state as final.

## 3. Accepted architecture (ADR 0016)

- `packages/domain/src/replay.ts` (new, pure): `replayToSequence`, `replayFull`, `replayChecksum`, `describeReplayEvent`, `actorOf`, version `REPLAY_VERSION="1.0.0"`. `draft.ts:replayFromEvents` retained as the authoritative final-state primitive; `replay.ts` delegates final-state equality to it (no second interpretation).
- Events API: backwards-compatible extension (array by default; `{ events, nextCursor, integrity }` with query params).
- Share model: new `draft_share_capabilities` table (one active row per draft, versioned rotation). `Draft.shareTokenHash` left untouched (legacy NULL).
- Share APIs: `POST/DELETE /api/v1/drafts/:id/share` (owner, COMPLETED only) + public `GET /share/[token]` page (server component, no Clerk) backed by `lib/server/share.ts`.
- Replay UI: `features/replay/ReplayControls.tsx` + `EventTimeline.tsx` (client, keyboard, aria-live, virtualized list) embedded in results page; read-only variant reused on share page with redacted DTO.
- Cleanup: `lib/server/share-cleanup.ts` + runbook.

## 4. Subagents and file ownership

- No subagents used for implementation (single working tree, strict ownership by primary agent). Graphify queries run directly (see §5).

## 5. Graphify queries

- Pre-implementation: `graphify explain DraftEvent`, `graphify path DraftEvent replayFromEvents`, `graphify explain DemoDraftCapability` (navigation aid; source verified directly afterwards).
- Post-gates: full `graphify update` + verification of the 11 required paths (see Verification section of task).

## 6. Milestone progress

- [x] Discovery + checkpoint + ADR 0016 (this file + docs/adr/0016)
- [x] M1 replay domain + golden/unit/property tests (`packages/domain/src/replay.ts`, 19 tests)
- [x] M2 timeline API (backwards-compatible cursor + integrity, 7 tests)
- [x] M3 replay + timeline UI on results page (`ReplaySection`, ui primitives + stories)
- [x] M4 share persistence (migration `20260907000000_phase3e2_sharing` fresh + upgrade)
- [x] M5 sharing APIs (create/revoke + rate limits + redaction, 12 tests)
- [x] M6 redacted shared-result view (`/share/[token]` + `SharedReplay`)
- [x] M7 revocation/expiration/cleanup + runbook (cleanup tested)
- [x] Benchmarks, Impeccable passes, docs, full verification (see §7–§9)

## 7. Commands and results

- `prisma generate` + `migrate deploy`: `20260907000000_phase3e2_sharing` applied to
  existing DB (upgrade path, data preserved); fresh `draftcourt_fresh` DB deploys all
  15 migrations cleanly with table/constraints/indexes/FK verified, then dropped.
- Domain: 118 passed (99 baseline + 19 replay), 9 files.
- Web unit: 310 passed + 1 documented skip (280 + same skip baseline; +30 new:
  12 share, 7 timeline, 11 replay-controls), 40 files.
- `tsc --noEmit`: clean (web, domain, ui, all 7 typecheck tasks).
- ESLint: 0 errors (3 warnings, all in preserved untracked `debug-runner.spec.ts`).
- Prettier: clean. `git diff --check`: clean.
- `next build`: clean, `/share/[token]` + share API routes in output.
- `storybook build`: clean (incl. new ReplayTransport stories).
- Bench `bench-replay-sharing.ts` → `docs/benchmarks/replay-sharing-latest.json` (see §8).
- Playwright `replay-sharing` (chromium): 3 consecutive passes (12–14s each).
  Covers: timeline cursor API + validation + legacy shape; replay First/Prev/
  Play/Pause/Next/Last, 1×/2×, scrub, Space/arrows/Home/End, focus stability,
  intermediate + final boards, undo history, integrity OK, analysis stability,
  UI share create, signed-out redacted view + leak scans (rendered text,
  console, error URLs, third-party refs), shared replay stepping, axe on both
  pages, 320px overflow on both pages, dark/light/reduced-motion/forced-colors,
  revoke → immediate 404, owner still 200, invalid-token 404, incomplete 409,
  foreign 404, idempotent revoke.
- Regression: `history-results,smoke,board-storybook` 30 passed; `mock-draft`
  passed standalone (2/2 post-change isolation runs + 1 flaky-pass).
- `pnpm test:all`: **All quality gates passed** — 186 passed, 30 skipped,
  0 failed (full formatting/lint/typecheck/migrate/seed/ingest/unit/pytest/
  contracts/build/E2E/analytics-image gate).
- Secret scan: 0 hits (secret patterns, token-shaped material in benchmarks
  proven to be hex-checksum substrings only).
- Graphify: refreshed post-gates — 7209 nodes (+265), 15238 edges (+457),
  549 communities, built from `e622cd1e` (current HEAD, fresh). Verified:
  DraftEvent→replayToSequence, lookupSharedResult→page→SharedReplay,
  listTimelineEventsForOwner→ReplaySection→EventTimeline, cleanup→share.ts,
  ReplaySection→results page.

### E2E debugging notes (kept for the record)

- League validation requires `totalRoster <= rounds` (roster 6 ⇒ rounds ≥ 6);
  initial 4-round fixture failed 422 — fixed to 4×6.
- Idempotency keys must be unique per attempt, not per pick number: reusing
  the pre-undo key after undo replays the undone outcome (200 duplicated, no
  cursor advance) and stalls the draft — fixed with per-guard keys.
- `getByText("Event N of M")` matches 3 nodes (live region + hint + output);
  assertions target `output.dc-replay-count` exactly.
- Raw share tokens necessarily appear in Next.js flight/router state for the
  visited path (address bar equivalent). Leak assertions target rendered text,
  console, error URLs, and third-party requests instead; threat model (§R7
  doc) records the nuance.

### Release-audit blocker fix (Gate 2/8, 2026-09-08)

- Symptom: `demo-drafts.test.ts` 2 failures (`Player has no eligibility for
this season`) after the Docker containers were wiped/recreated (same data
  volume). Proven pre-existing: eligibility check byte-identical at HEAD;
  zero demo/seed/ingest files in the 3E2 diff; mechanism fully in test+data
  (unordered `findFirst` over 239 projected players, 8 legitimately lacking
  eligibility rows; plan-dependent row choice flipped after restart).
- Fix (minimal, non-weakening): added the file's own existing pattern
  `orderBy: { overallRank: "asc" }` to the two unordered selections. No
  assertion changed; suite back to 16/16. File
  `apps/web/tests/unit/demo-drafts.test.ts` joins the release manifest with
  this justification.

### mock-draft twin-swap flake (residual, not a 3E2 regression)

- `test:all` run 1: mock-draft failed once on the same-seed twin assertion
  (adjacent user-pick transposition at the snake turn-around); history-results
  flaked then passed in the same run.
- Evidence it is not 3E2: twin-path files (recommendation, cpu-selector,
  cpu-personalities, server recommendations/cpu-mock, draft.ts) are
  byte-identical to baseline; all other modified files have purely additive
  diffs (zero removed lines verified); recommendation storage is draft-scoped
  (`draftId` in unique key + engine seed); mock-draft passed standalone
  before and after (2 clean passes + 1 flaky-pass across 4 post-change runs).
- Full `test:all` rerun: green (186/0). Treat twin determinism under parallel
  load as a known-sensitive assertion (near-tie at the turn-around); do not
  expand 3E2 scope to rework the Phase 2 engine.

## 8. Benchmarks

From `docs/benchmarks/replay-sharing-latest.json` (local docker postgres,
darwin, 2026-09-07; computation only, no presentation timing):

| Measurement                       | p50           | p95     | n   |
| --------------------------------- | ------------- | ------- | --- |
| pure replay 12×14 (170 events)    | 0.80ms        | 4.22ms  | 20  |
| pure replay 20×20 (402 events)    | 1.89ms        | 6.33ms  | 20  |
| random sequence seek              | 0.44ms        | 1.49ms  | 20  |
| sequential playback, all prefixes | 73.39ms total | —       | 1   |
| event pagination (10)             | 7.25ms        | 26.37ms | 20  |
| shared lookup, first              | 29.69ms       | —       | 1   |
| shared lookup, warm               | 7.81ms        | 12.03ms | 20  |
| token digest derivation           | 0.016ms       | 0.08ms  | 20  |
| shared DTO construction           | 8.08ms        | 12.02ms | 20  |
| cleanup batch                     | 2.22ms        | 14.72ms | 3   |
| concurrent share creation ×4      | 6.86ms        | 19.18ms | 5   |

Fixture checksums recorded in the JSON (standard + large). Token algorithm:
SHA-256 hex of 256-bit base64url, no secrets recorded.

## 9. Remaining work

- Phase 3E2 implementation is complete and verified; the combined Phase 3
  checklist box stays unchecked per policy until every authoritative Phase 3
  requirement (motion/themes/mobile/visual-regression acceptance, benchmarks
  - portfolio docs, full phase acceptance) is complete — that decision belongs
    to a later acceptance pass, not this task.
- Suggested follow-ups (not 3E2 gaps): twin-determinism hardening in the
  Phase 2 engine if the flake recurs; Clerk-host CSP allowlist cleanup
  (prior low-risk note, untouched); Storybook visual snapshots for the new
  replay stories in the visual-regression suite.
