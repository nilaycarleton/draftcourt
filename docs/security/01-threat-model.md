# Threat model (system-wide)

Scope: the deployed DraftCourt surface as it exists in code. Each row
names the control and its evidence file. Items with no implemented
control are marked OPERATOR-EVIDENCE-NEEDED rather than hand-waved.

| Threat                                    | Control (implemented)                                                                                                                                                                                                           | Evidence                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Session forgery / missing auth            | Clerk verification on every private route; `getCurrentUser()` resolves session → `users` row, `null` when unconfigured/sessionless/unmirrored                                                                                   | ADR 0009; `apps/web/lib/server/auth.ts`; `apps/web/lib/api/admin-guard.ts`                                                                  |
| Privilege escalation to admin             | `ADMIN` only via server-controlled `publicMetadata.draftcourtRole` + DB mirror; `unsafeMetadata` ignored; 401 vs 403 without existence signal                                                                                   | ADR 0009; `apps/web/lib/server/clerk-sync.ts`                                                                                               |
| IDOR / cross-user reads                   | Owner scoping on every league/draft/preference/rank/analysis/history/events route; foreign IDs → uniform 404                                                                                                                    | ADR 0009; ADR 0012; ADR 0015 D6; ADR 0016 R3                                                                                                |
| Enumeration oracle                        | Identical 404 shapes for missing/foreign/invalid/revoked/expired across owner, demo, and share paths                                                                                                                            | ADR 0014 D3; ADR 0016 R4–R7                                                                                                                 |
| Guest escape (demo → owner data)          | `ownerId` NULL demos, capability-only access, history excludes `DEMO`, demos never shareable                                                                                                                                    | ADR 0014 D1–D2; ADR 0015 D6                                                                                                                 |
| Share-token guessing                      | 256-bit CSPRNG tokens (43-char base64url), digest-only storage, constant-time compare, throttled blind 404s                                                                                                                     | ADR 0016 R4, R7; `apps/web/lib/server/demo-tokens.ts:28-66`                                                                                 |
| Token leakage via logs/Sentry/analytics   | Raw tokens never stored/logged/audited/cached; `scrubSentryEvent` extended for share/demo material; audit rows carry ids/versions/counts only                                                                                   | ADR 0016 R7; `apps/web/lib/sentry-redact.ts`; `services/analytics/app/core/sentry.py`                                                       |
| Referrer / crawler leakage of share URLs  | Path-segment tokens (never query), `Referrer-Policy: no-referrer`, `noindex/noarchive` meta + headers, `private, no-store`                                                                                                      | ADR 0016 R6; `docs/architecture/replay-and-sharing.md` §4                                                                                   |
| Webhook forgery                           | Svix signature verified against the raw body before mirroring                                                                                                                                                                   | ADR 0008; `apps/web/app/api/v1/webhooks/clerk/route.ts`                                                                                     |
| Service-impersonation (web → analytics)   | Shared bearer secret (constant-time) + ±300 s timestamp replay window; safe RFC 9457 errors, exception text server-side only                                                                                                    | `services/analytics/app/api/internal.py:141-157`; `.env.example:50-53`                                                                      |
| Double-pick / replay attacks on mutations | Row-locked single transaction + `If-Match` versions (409 + authoritative state) + `Idempotency-Key` replay                                                                                                                      | ADR 0010; `apps/web/app/api/v1/drafts/[id]/picks/route.ts:22-44`                                                                            |
| Rate-limit bypass / abuse                 | Per-user, per-draft, per-hashed-IP fixed windows (recalc, prefs, demo, share); Redis with Postgres `audit_log` fallback so limits hold degraded                                                                                 | `apps/web/lib/server/recommendations.ts:252-268`; `preference-profiles.ts:369-379`; `demo-rate-limit.ts:18-24`; `share-rate-limit.ts:20-30` |
| Injection (SQL / formula / file)          | Parameterized Prisma/SQLAlchemy access, Zod/Pydantic validation at boundaries, CSV formula-injection neutralization per §13 (scope: validation code as implemented)                                                             | BUILD_SPEC §13; `apps/web/lib/server/admin-validation.ts`                                                                                   |
| SSRF via source adapters                  | Only `DemoFileAdapter` (local files) exists; live-adapter SSRF controls (allowlist egress, no page-request fetching) are specified in BUILD_SPEC §7.2 but have no implementation — must be designed with the first live adapter | ADR 0006; **gap acknowledged**                                                                                                              |
| Stale revocation (share/demo)             | `revokedAt`/`expiresAt` enforced inside the lookup query; rotation kills the old digest in the same update                                                                                                                      | ADR 0014 D4; ADR 0016 R4–R5                                                                                                                 |
| Cleanup overreach                         | Advisory-locked, batch-100, idempotent cleaners that delete only expired/long-revoked capability rows, never product data                                                                                                       | ADR 0014 D4; ADR 0016 R5; `apps/web/lib/server/share-cleanup.ts`; `demo-cleanup.ts`                                                         |
| Secret sprawl                             | `.env.example` documents names only; required vars fail fast, optional integrations default to disabled                                                                                                                         | ADR 0004; `.env.example`                                                                                                                    |
| Dependency / container risk               | Pinned toolchains + lockfiles; `security.yml` runs dependency review/CodeQL/secret scan/audits/Trivy per BUILD_SPEC §17 — pipeline output not verified in this task                                                             | ADR 0001; `.github/workflows/security.yml`; **OPERATOR-EVIDENCE-NEEDED for current scan results**                                           |
| Retention / deletion                      | Demo TTL 24 h with cleanup; share TTL 90 d with cleanup; account/data deletion and per-source raw retention docs are required before public launch (BUILD_SPEC §13, §20) — **not observed; OPERATOR-EVIDENCE-NEEDED**           | ADR 0014 D4; ADR 0016 R5                                                                                                                    |

## Incident response pointers

Alert → triage → escalation lives in
`docs/operations/04-incident-response.md` (covers the BUILD_SPEC §19
alert list). Log/Sentry redaction behavior is part of every incident
call: share/demo tokens, digests, emails, and owner/Clerk IDs must never
appear in pasted evidence.

## Sources

- `BUILD_SPEC.md` §7.2, §13, §17, §19, §20
- `docs/adr/0004-local-dev-and-deployment-foundations.md`
- `docs/adr/0006-source-adapter-framework.md`
- `docs/adr/0008-background-jobs-and-caching.md`
- `docs/adr/0009-admin-authorization.md`
- `docs/adr/0010-phase2-draft-core-and-recommendations.md`
- `docs/adr/0012-immutable-preference-snapshots.md`
- `docs/adr/0014-guest-demo-mock-drafts.md`
- `docs/adr/0015-draft-analysis-and-history.md`
- `docs/adr/0016-replay-and-private-sharing.md`
- `docs/architecture/06-trust-boundaries.md`
- `docs/architecture/replay-and-sharing.md` §6
- `apps/web/lib/server/auth.ts`
- `apps/web/lib/api/admin-guard.ts`
- `apps/web/lib/api/envelope.ts`
- `apps/web/lib/sentry-redact.ts`
- `apps/web/lib/security-headers.ts`
- `apps/web/lib/content-security-policy.ts`
- `services/analytics/app/api/internal.py`
- `services/analytics/app/core/sentry.py`
- `.env.example` (names only)
