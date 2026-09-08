# Runbook: share links — stuck cleanup, abuse, accidental sharing, revocation, suspected leakage

Covers private result-sharing capabilities (`draft_share_capabilities`,
ADR 0016 R4–R7). Share links are 90-day, revocable, read-only, and scoped to
one COMPLETED non-DEMO result. Raw tokens are never stored — only SHA-256 hex
digests — so no runbook step can ever "look up" a raw token.

## 1. Revoke a link immediately (accidental sharing)

Owner path (preferred — instant):

```bash
curl -s -X DELETE http://localhost:3100/api/v1/drafts/<draftId>/share \
  -H "Cookie: <owner session cookie>" | python3 -m json.tool
# {"data":{"revoked":true},...} — public access dies on this response.
```

Verify from a signed-out context:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/share/<token>
# expect 404 (revoked, expired, and invalid are indistinguishable by design)
```

The owner result page is unaffected by revocation. If the owner lost the
token, revocation by `draftId` still works — no token needed.

## 2. Rotate a leaked link (suspected token leakage)

1. Revoke first (step 1) so the old digest dies immediately.
2. Create a fresh link: `POST /api/v1/drafts/<draftId>/share` (returns a new
   raw URL exactly once; store it in the password manager, never in chat,
   tickets, or logs).
3. Confirm the old URL 404s and the new URL 200s (signed-out `curl`).
4. Audit: `SELECT action, "entityId", "createdAt" FROM audit_log WHERE
"entityType"='draft_share' AND "entityId"='<draftId>' ORDER BY
"createdAt" DESC;` — rows contain versions/expiry only, never tokens.

Never paste a raw token into Sentry, logs, analytics, or error reports. The
Sentry scrubber strips 43-char base64url segments, auth headers, cookies, and
`shareToken/shareDigest/capabilityToken` keys, but redaction is defense in
depth — the primary control is never emitting the token.

## 3. Abuse (scraping, token-guessing)

- Public lookups: 60/min per hashed IP; token failures: 10/5min per hashed
  IP. Both return identical 404s with no validity oracle, so guessing is
  blind as well as throttled.
- Owner create/revoke: 10/hour and 30/hour per user respectively (429 with
  `Retry-After` semantics; no validity signal).
- If an IP hammers `/share/*`, block at the edge/proxy; the app never needs
  a code change. Confirm via rate-limit audit rows:
  `SELECT COUNT(*) FROM audit_log WHERE action LIKE 'share.ratelimit:%'
AND "createdAt" > now() - interval '1 hour';` (Redis-backed when
  available; Postgres fallback otherwise — keys are SHA-256(ip|ua), never raw
  IPs).

## 4. Stuck cleanup

`runShareCleanupBatch` (`apps/web/lib/server/share-cleanup.ts`) deletes
expired rows and rows revoked >7 days ago, batch 100, under its own advisory
lock (never the demo-cleanup lock), and reports redacted counts only.

- "Could not acquire share cleanup lock" in the result → another run is in
  progress; wait for the hourly schedule and re-check. Never kill Postgres
  backends to free the lock — it self-releases in `finally`.
- Backlog check:
  `SELECT COUNT(*) FROM draft_share_capabilities WHERE "expiresAt" < now()
OR ("revokedAt" IS NOT NULL AND "revokedAt" < now() - interval '7 days');`
- Re-run one bounded batch manually (idempotent, safe with live reads):
  invoke `runScheduledShareCleanup()` from the job runner; it audit-logs
  `{scanned, deletedExpired, deletedRevoked, durationMs, errors}`.
- Cleanup NEVER deletes drafts, analyses, events, history, or demo/guest
  rows — if any of those counts move during a cleanup window, stop the job
  and escalate (expected cause: someone pointed cleanup at the wrong table,
  not this code path, which deletes from `draft_share_capabilities` only).

## 5. Replay divergence (integrity FAIL on results/share pages)

1. Trust the final board/analysis (authoritative read model), not the
   step-by-step replay.
2. Compare: `verifyReplayIntegrity(draftId)` detail (`assignment rows X !=
replayed Y` vs `sequence divergence`) localizes the fault.
3. Common causes: manual DB edits, a migration that touched events (never do
   this — events are append-only), or clock-skewed out-of-order inserts.
4. Fix: append a compensating event through the API (undo/re-pick), never
   UPDATE/DELETE `draft_events` in place.

## 6. Rollback

Schema change is additive (`draft_share_capabilities` only;
`drafts.shareTokenHash` untouched). To disable sharing without a migration:
return 503 from `POST/DELETE .../share` behind a flag and stop scheduling
cleanup — existing rows simply expire (90 days) and public lookups keep
enforcing expiry/revocation. No data rollback ever required.
