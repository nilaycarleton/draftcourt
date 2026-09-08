# Replay methodology and private result sharing (Phase 3E2, ADR 0016)

## 1. Replay methodology

Replay is a pure sequence-sliced reduction over the append-only `DraftEvent`
log (`packages/domain/src/replay.ts`, `REPLAY_VERSION 1.0.0`):

- Input: ordered events + `teamCount` + `uptoSequence`. Output: effective
  selections (keepers included, undone excluded), per-team pick lists,
  `currentSequence`, `nextOverallPick`, lifecycle flags, and a stable SHA-256
  checksum over canonicalized selections.
- Snake numbering counts effective picks only: `round =
ceil(overall/teamCount)`, `pickInRound = ((overall-1) % teamCount)+1`.
- Undo removes the selection referenced by `causationEventId` and decrements
  the cursor, so undo-then-repick (alternate history) reuses the number —
  matching the authoritative transaction exactly.
- Final-state output is differential-tested byte-equal to
  `draft.ts:replayFromEvents` (the transaction's incremental twin). There is
  exactly one replay interpretation.
- No wall-clock, no network, no DB, no projections/preferences: historical
  picks are never recalculated from current data. Bounded at 5000 events.

### Integrity

`verifyReplayIntegrity` (count + sequence comparison) feeds the timeline API
and both replay UIs. Any typed `ReplayError` (gap, duplicate, corrupt undo,
unknown state-changing event, illegal slot, over bound) renders `FAIL` with
an actionable message — replay is never shown as trustworthy on failure.

## 2. Historical event compatibility policy

- All six accepted event types and all observed payload versions (keeper
  flags, CPU evidence, preference-snapshot evidence, empty lifecycle
  payloads) replay deterministically, forever.
- Old rows are never rewritten or normalized in place.
- Unknown future types: preserved as timeline markers when they carry no
  `playerId`/`teamSlot`/`causationEventId`; fail closed otherwise.

## 3. Replay sequence diagram

```mermaid
sequenceDiagram
    participant Owner as Owner browser
    participant Page as /drafts/[id]/results
    participant Replay as ReplaySection (client)
    participant API as GET events (owner)
    participant Domain as replayToSequence
    Owner->>Page: open completed result
    Page->>Replay: mount (final state)
    Replay->>API: fetch immutable event log
    API-->>Replay: ordered events + names
    Replay->>Domain: reduce to position p
    Domain-->>Replay: selections + checksum
    Replay-->>Owner: board + rosters + timeline
    Note over Replay,Domain: stepping changes p only;<br/>never a mutation
```

Share replay is identical except the source is the redacted DTO
(`undoneAtSequence` replaces internal causation ids).

## 4. Share API

| Method | Route                      | Auth                   | Purpose                                            |
| ------ | -------------------------- | ---------------------- | -------------------------------------------------- |
| POST   | `/api/v1/drafts/:id/share` | owner, COMPLETED only  | create/rotate; returns raw `shareUrl` exactly once |
| DELETE | `/api/v1/drafts/:id/share` | owner                  | immediate revocation; idempotent                   |
| GET    | `/share/:token`            | capability (path only) | redacted read-only result page                     |

- Token: 32 CSPRNG bytes → 43-char base64url (256-bit). Digest: hex SHA-256.
- POST on an existing row rotates (`version+1`, old digest dies). Concurrent
  creators: single winner via `draftId UNIQUE`; losers rotate the winner.
- All failures are enumeration-resistant: foreign drafts 404, own incomplete
  409, invalid/revoked/expired public tokens 404 (identical shape).
- Rate limits: create 10/h per user, revoke 30/h per user, public lookup
  60/m per hashed IP, token failures 10/5m per hashed IP (Redis, Postgres
  fallback; no validity oracle).
- Headers: `Cache-Control: private, no-store`, `Referrer-Policy:
no-referrer`, `X-Robots-Tag: noindex, noarchive` + robots meta. No query
  tokens, no auth cookies, no third-party referrer receivers.

## 5. Redacted public DTO

Included: safe title label (`Draft results · <season> · <T> teams × <R>
rounds`), league type/horizon/dimensions, final board (overall/round/team +
display names + slot), team display names, final rosters, grade + 5
components + round value + strengths/weaknesses + standings + version +
truncated checksum + freshness (status/dates only) + synthetic-baseline and
no-guarantee disclosures, read-only redacted replay timeline.

Excluded: emails, Clerk/owner/guest ids, capability material, digests,
private notes, preferences/favorites/targets/avoids, custom ranks, audit
data, internal event/player/run/snapshot UUIDs, recommendation internals,
full checksums, other drafts/history, raw payloads.

## 6. Threat model (sharing)

| Threat                    | Control                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Token guessing            | 256-bit entropy + throttled blind 404s                                                                                                 |
| DB leak                   | digests only; no raw tokens anywhere                                                                                                   |
| Log/Sentry/analytics leak | never emitted; scrubber strips token-shaped segments + share keys + URLs                                                               |
| Referrer leak             | path-only token, `no-referrer`, no third-party embeds                                                                                  |
| Crawler indexing          | `noindex, noarchive` (meta + header)                                                                                                   |
| Stale access after revoke | `revokedAt` checked in the lookup query itself                                                                                         |
| Clock games               | server time only                                                                                                                       |
| Capability confusion      | share digests and demo hashes in separate tables; neither authorizes the other's routes; share authorizes no mutation and no owner API |
| Accidental mass share     | per-user creation limits; one active row per draft                                                                                     |
| Cleanup overreach         | deletes share rows only; runbook + test pin the scope                                                                                  |

## 7. Revocation, expiration, cleanup

- TTL 90 days from creation (BUILD_SPEC defines demo 24h but no share TTL;
  ADR 0016 R5 sets it explicitly). `expiresAt` enforced in the lookup query.
- `revokedAt` invalidates immediately; DELETE is idempotent.
- Rotation invalidates the old digest in the same update.
- Cleanup (`runShareCleanupBatch`): advisory-locked, batch-100, idempotent;
  deletes expired rows + rows revoked >7 days ago; safe with live reads;
  redacted counts only. See `docs/runbooks/share-revocation-cleanup.md`.
