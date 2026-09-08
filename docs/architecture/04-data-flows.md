# Data flows

Six flows, each with participants, ordering guarantees, and failure
behavior. All fixtures below are illustrative, not production data.

## 1. Authenticated read (request flow)

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as apps/web route
    participant A as auth.ts / admin-guard.ts
    participant P as Postgres (Prisma)
    B->>W: GET /api/v1/... (Clerk cookie)
    W->>A: getCurrentUser() → users row
    alt no session / no row → 401; row without ADMIN → 403
        W-->>B: RFC 9457 problem, no existence signal
    else authorized
        W->>P: owner-scoped query
        W-->>B: {data, error:null, meta:{traceId,...}}
    end
```

Owner authorization happens after authentication and before database
access where practical (BUILD_SPEC §8). Foreign IDs are indistinguishable
from missing IDs (uniform 404) on leagues, drafts, preferences, ranks,
history, analysis, and events (ADR 0009; ADR 0012; ADR 0015 D6; ADR 0016 R3).

## 2. Draft mutation (pick / undo / CPU pick / transitions)

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as Route (If-Match + Idempotency-Key)
    participant T as drafts.ts transaction
    participant P as Postgres
    B->>W: POST picks/undo/cpu-pick (If-Match: version)
    W->>T: makePick / undoPick / transitionStatus
    T->>P: SELECT … FOR UPDATE (draft row lock)
    P-->>T: locked row + authoritative version
    alt stale version → 409 with authoritative state
        T-->>B: 409 + current state (no second read needed)
    else duplicate Idempotency-Key → replay recorded outcome
        T-->>B: 200 recorded outcome
    else valid
        T->>P: append event + roster write + cursor + version + outbox (ONE txn)
        T-->>B: 200 new version + state
    end
```

One transaction path serves human, CPU, and guest picks; CPU decisions
run inside the same locked transaction via an internal decision provider,
and the CPU endpoint takes no player/team input (arbitrary-player
injection is structurally impossible). (ADR 0010; ADR 0013)

## 3. Ingestion → publish (analytics pipeline)

```mermaid
flowchart LR
    A["DemoFileAdapter.extract()<br/>data/demo/*.json"] --> B["checksum (sha256 canonical JSON)<br/>dedup on (sourceId, checksum)"]
    B --> C["Pydantic validate<br/>VALIDATED vs QUARANTINED"]
    C -->|"invalid"| Q["RawSourceRecord QUARANTINED<br/>+ JSON-safe errors"]
    C -->|"valid"| D["normalize → reconcile identity<br/>(provider ID, then name+DOB<br/>thresholds 75 / 92)"]
    D -->|"CANDIDATE (75–92)"| U["VALIDATED, not PUBLISHED<br/>retried on later runs"]
    D -->|"CONFIRMED / new"| E["publish normalized rows<br/>teams → players → stats/ADP/signals"]
    E --> F["publish_baseline_run<br/>atomic flip of isCurrent<br/>(partial unique index)"]
```

- Re-running is fully idempotent: same payloads checksum-skip; a new
  `IngestionRun` row records the no-op attempt (ADR 0006).
- Publishing is atomic: the partial unique index
  `projection_runs_one_current_per_season` rejects any transaction that
  would leave two current runs, so readers never see a half-published
  state (ADR 0005).
- Scheduled shape: Inngest `nightly-source-refresh-and-publish` (cron
  `0 6 * * *`, retries 3, concurrency 1, deterministic daily
  `Idempotency-Key`) calls the internal HTTP endpoints, never the CLI
  (ADR 0008).

## 4. Recommendation flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as recommendations.ts
    participant D as packages/domain engine
    participant P as Postgres
    B->>W: GET recommendations (draft, sequence)
    W->>P: load settings snapshot + events + projections + ADP + pref snapshot
    W->>D: canonical input → inputChecksum
    alt snapshot row matches (draftId, sequence, inputChecksum) + engineVersion
        P-->>W: cached payload (upsert-in-place identity)
    else miss
        W->>D: pure compute (250-run availability, lookahead ≤10%)
        W->>P: persist snapshot + mark outbox processed
    end
    W-->>B: top-3 + breakdown + warnings
```

No stale cache can touch pick legality: legality is enforced
transactionally against live tables, never from snapshots (ADR 0010).
Recalculation is gated at 4 requests / 30 s per draft
(`apps/web/lib/server/recommendations.ts:252-268`).

## 5. Analysis flow (post-draft grade)

Trigger: `GET /api/v1/drafts/:id/analysis` performs idempotent recovery
generation when a `COMPLETED` draft has no current `DraftAnalysis`
(preferred over a new outbox kind). Unique
`(draftId, analysisVersion, inputChecksum)` returns the cached row; a new
analysis version creates a new row, never an overwrite. Simulation
(2000 seeded runs) is computed outside the insert transaction.
(ADR 0015 D2, D5)

## 6. Sharing flow (private result link)

```mermaid
sequenceDiagram
    participant O as Owner
    participant W as web share endpoints
    participant V as Signed-out visitor
    O->>W: POST /api/v1/drafts/:id/share (COMPLETED REAL/MOCK only)
    W-->>O: raw shareUrl EXACTLY ONCE (never stored/logged)
    O->>V: sends URL out of band
    V->>W: GET /share/:token (path segment, never query)
    W->>W: format check → SHA-256 digest → lookup<br/>(revokedAt IS NULL AND expiresAt > now())
    alt invalid / revoked / expired → identical 404
        W-->>V: indistinguishable not-found
    else valid
        W-->>V: redacted DTO + noindex/no-store headers
    end
```

Rotation (`POST` on an existing row) issues version+1 and kills the old
digest in the same update; `DELETE` sets `revokedAt` (idempotent).
(ADR 0016 R4–R6; `docs/architecture/replay-and-sharing.md` §4–§7)

## Sources

- `docs/adr/0005-phase1-data-model.md`
- `docs/adr/0006-source-adapter-framework.md`
- `docs/adr/0008-background-jobs-and-caching.md`
- `docs/adr/0009-admin-authorization.md`
- `docs/adr/0010-phase2-draft-core-and-recommendations.md`
- `docs/adr/0012-immutable-preference-snapshots.md`
- `docs/adr/0013-cpu-personalities-and-mock-drafts.md`
- `docs/adr/0015-draft-analysis-and-history.md`
- `docs/adr/0016-replay-and-private-sharing.md`
- `docs/architecture/replay-and-sharing.md`
- `apps/web/lib/server/recommendations.ts`
- `apps/web/lib/api/envelope.ts`
- `services/analytics/app/api/internal.py`
