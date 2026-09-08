# API conventions (only what exists in code)

Every claim below names its implementation file. Nothing here is
aspirational.

## Envelope + traceId

All `/api/v1/*` routes return `{ data, error, meta }` with
`meta.traceId` (uuid). `ok(data)` sets `error: null`;
`problem(details)` sets `data: null` and the HTTP status from
`details.status`. (`apps/web/lib/api/envelope.ts:11-64`)

## RFC 9457 errors

`error` is a `ProblemDetails` object: `type` (stable `/problems/*`
slug), `title`, `status`, optional `detail`, optional field-level
`errors`, optional `authoritative` state on version conflicts so clients
reconcile without a second read. Implemented slugs in
`apps/web/lib/api/envelope.ts:66-114`: `/problems/bad-request`,
`/problems/validation-error` (422), `/problems/unauthorized` (401),
`/problems/forbidden` (403), `/problems/not-found` (404),
`/problems/conflict` (409), `/problems/internal-error` (500).
Additional slugs are used by individual routes (e.g. demo-expiry,
draft-not-ready, rate-limited, invalid-strategy — see the ADRs in
Sources); the analytics service answers plain problem JSON without the
web envelope (`services/analytics/app/api/internal.py:97-127`).

## Cursor pagination

| Surface                 | Cursor shape                                                                                       | Implementation                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Leagues list            | Prisma id cursor (`cursor.id`, `skip: 1`), `nextCursor`                                            | `apps/web/lib/server/leagues.ts:174-191`                            |
| History (`/me/history`) | id cursor, stable `orderBy [{updatedAt:desc},{id:asc}]`, backed by `@@index([ownerId, updatedAt])` | `apps/web/lib/server/history.ts:8-127`; ADR 0015 D6                 |
| Preference profiles     | id cursor                                                                                          | `apps/web/lib/server/preference-profiles.ts:405-419`                |
| Players                 | base64url-encoded offset cursor                                                                    | `apps/web/lib/server/players.ts:277-402`; `players-query.ts:66-133` |
| Draft events timeline   | integer sequence cursor (`sequence > cursor`), limit 1–100, ascending                              | `apps/web/lib/server/drafts.ts:739-852`                             |

Unpaginated legacy mode on `GET events` (no query params) returns the
plain array for existing callers (ADR 0016 R3).

## Idempotency-Key + If-Match + 409

Draft mutations (`picks`, `undo`, `cpu-pick`) and all demo mutations
except one-way `abandon` require both headers: `If-Match` (integer draft
version, optimistic concurrency) and `Idempotency-Key` (safe
retry/redelivery; 8–128 chars on owner picks, non-empty ≤200 chars on
demo routes). Stale versions answer 409 with authoritative state;
duplicate keys replay the recorded outcome. Verified in
`apps/web/app/api/v1/drafts/[id]/picks/route.ts:22-44`,
`.../undo/route.ts:15-31`, `.../cpu-pick/route.ts:26-70`, and the
`demo-drafts/[id]/*/route.ts` handlers (abandon documents why it skips
`If-Match`: one-way destructive action).

## Rate limits (all with Postgres fallback unless noted)

| Surface                                                  | Limit                                         | Key                         | Implementation                                       |
| -------------------------------------------------------- | --------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| Recommendation recalculate                               | 4 / 30 s per draft (Postgres-count, no Redis) | draft                       | `apps/web/lib/server/recommendations.ts:252-268`     |
| Preference mutations                                     | 30 / min per user                             | user                        | `apps/web/lib/server/preference-profiles.ts:369-379` |
| Demo create / resume / userPick / cpuPick / tokenFailure | 3/h, 30/m, 10/30 s, 10/30 s, 5/5 m            | hashed IP / capability hash | `apps/web/lib/server/demo-rate-limit.ts:18-24`       |
| Share create / revoke / lookup / tokenFailure            | 10/h, 30/h, 60/m, 10/5 m                      | user / hashed IP            | `apps/web/lib/server/share-rate-limit.ts:20-30`      |

Answers use RFC 9457 problems with `Retry-After`; invalid/expired/missing
capability tokens return identical 401/403 shapes (no enumeration
oracle). (ADR 0014 D3; ADR 0016 R7)

## `/v1` versioning

All product APIs live under `/api/v1`. The only exceptions are
`GET /api/health`, `POST /api/inngest`, and the page route
`/share/:token` — all documented in `01-inventory.md`. Engine, snapshot,
and analysis payloads carry their own version constants
(`phase3-preferences-1.0.0`, snapshot v1, analysis `1.0.0`, replay
`1.0.0`) so old rows stay readable under recorded versions (ADR 0012;
ADR 0015 D2; ADR 0016 R2).

## Sources

- `apps/web/lib/api/envelope.ts`
- `apps/web/app/api/v1/drafts/[id]/picks/route.ts`
- `apps/web/app/api/v1/drafts/[id]/undo/route.ts`
- `apps/web/app/api/v1/drafts/[id]/cpu-pick/route.ts`
- `apps/web/app/api/v1/drafts/[id]/recommendations/recalculate/route.ts`
- `apps/web/app/api/v1/demo-drafts/[id]/picks/route.ts`
- `apps/web/app/api/v1/demo-drafts/[id]/cpu-pick/route.ts`
- `apps/web/app/api/v1/demo-drafts/[id]/undo/route.ts`
- `apps/web/app/api/v1/demo-drafts/[id]/complete/route.ts`
- `apps/web/app/api/v1/demo-drafts/[id]/abandon/route.ts`
- `apps/web/lib/server/recommendations.ts`
- `apps/web/lib/server/preference-profiles.ts`
- `apps/web/lib/server/demo-rate-limit.ts`
- `apps/web/lib/server/share-rate-limit.ts`
- `apps/web/lib/server/leagues.ts`
- `apps/web/lib/server/history.ts`
- `apps/web/lib/server/players.ts`
- `apps/web/lib/server/players-query.ts`
- `apps/web/lib/server/drafts.ts`
- `services/analytics/app/api/internal.py`
- `docs/adr/0012-immutable-preference-snapshots.md`
- `docs/adr/0014-guest-demo-mock-drafts.md`
- `docs/adr/0015-draft-analysis-and-history.md`
- `docs/adr/0016-replay-and-private-sharing.md`
