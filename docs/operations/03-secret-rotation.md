# Secret rotation

Rotation mechanism in this architecture is **redeploy both services with
a new shared value**; there is no per-request signing and no hot-reload
(ADR 0008). No live-rotation proof exists — every rotation below ends
with an **OPERATOR-EVIDENCE-NEEDED** rehearsal note. Names only; no
values appear here (see `.env.example`).

## Detection

Rotate on a schedule (define one before public launch), on any suspected
exposure (log/Sentry hit, leaked `.env.local`, departing operator), or
when a provider forces it (Clerk/Inngest dashboard events).

## Containment

On suspected exposure: revoke/roll the secret at the provider first
(Clerk, Inngest), then rotate the local copies. For the shared service
secret, assume both `ANALYTICS_SERVICE_SECRET` (web) and
`SERVICE_SECRET` (analytics) are compromised together — they must match.

## Recovery — per secret

| Secret (`.env.example` name)                                        | Rotate by                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANALYTICS_SERVICE_SECRET` / `SERVICE_SECRET`                       | Generate a new random value; set **both** names identically; redeploy web + analytics together. Mismatched deploys 401 every internal call — deploy analytics first, then web, and watch internal 401s as the canary. Timestamp window `SERVICE_AUTH_TIMESTAMP_WINDOW_SECONDS` (±300 s default) covers clock skew only, not mismatched secrets. |
| `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`             | Roll in the Clerk dashboard; update provider secret store + local `.env.local`; redeploy. Until both sides agree, private routes 401.                                                                                                                                                                                                           |
| `CLERK_WEBHOOK_SIGNING_SECRET`                                      | Roll in Clerk; update the webhook endpoint secret; replay a test webhook (Svix) to confirm the mirror still writes.                                                                                                                                                                                                                             |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, `REDIS_URL`  | Rotate at the provider; redeploy. Redis is optional — a bad value degrades to the Postgres fallback, not an outage (`demo-rate-limit.ts`, `share-rate-limit.ts`).                                                                                                                                                                               |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`                         | Roll in Inngest; redeploy; confirm the next scheduled run authenticates.                                                                                                                                                                                                                                                                        |
| `SENTRY_DSN` / `SENTRY_AUTH_TOKEN`                                  | Roll in Sentry; redeploy. Empty/absent DSN is a supported no-op state (ADR 0004), so this rotation is low-risk.                                                                                                                                                                                                                                 |
| `OPENAI_API_KEY`                                                    | Premium/future scope; currently disabled (`AI_ASSISTANT_ENABLED=false`). No rotation path exercised.                                                                                                                                                                                                                                            |
| `MODEL_ARTIFACT_*`, `NBA_SOURCE_BASE_URL`, `INJURY_SOURCE_BASE_URL` | No live backend exists; names reserved. No rotation path exercised.                                                                                                                                                                                                                                                                             |

## Verification

- Internal calls succeed: trigger one idempotent internal job status read
  and confirm no 401 spike in analytics logs.
- Clerk webhook test event mirrors (or at minimum verifies) successfully.
- `GET /api/health` and one authenticated read pass post-deploy.
- Record the rotation date and the two deploy SHAs.

## Rollback

Re-set the previous values and redeploy the same two services. Because
rotation is deploy-based, "rollback" is an ordinary redeploy — keep the
previous provider values until verification passes where the provider
allows overlap.

## Escalation

If web and analytics cannot agree on the service secret (persistent
internal 401s): freeze scheduled jobs (pause the Inngest cron), serve
from the last published run with the freshness banner (degraded mode per
`05-redis-analytics-outage.md`), and roll forward to a fresh value on
both sides. **OPERATOR-EVIDENCE-NEEDED**: no live rotation has been
rehearsed; schedule a game-day before public launch.

## Sources

- `docs/adr/0004-local-dev-and-deployment-foundations.md`
- `docs/adr/0008-background-jobs-and-caching.md`
- `docs/operations/01-runbook-template.md`
- `docs/operations/05-redis-analytics-outage.md`
- `services/analytics/app/api/internal.py`
- `services/analytics/app/core/security.py`
- `apps/web/lib/server/analytics-client.ts`
- `apps/web/lib/server/demo-rate-limit.ts`
- `apps/web/lib/server/share-rate-limit.ts`
- `.env.example` (names only)
