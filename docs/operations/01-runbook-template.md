# Runbook template

Copy this file for each new runbook. Every section header below is
**required** — delete none; write "N/A with reason" if a section truly
does not apply. Existing runbooks that predate this template
(`docs/runbooks/stale-data.md`, `failed-publish-rollback.md`,
`share-revocation-cleanup.md`, `source-disable.md`) should be migrated to
these headers when next touched.

```markdown
# Runbook: <incident or task>

## Detection

How the problem is noticed: alert name, dashboard, log line, user
report. Name the exact signal (e.g. BUILD_SPEC §19 alert, Inngest
failure, Sentry issue) and where to look first.

## Containment

Immediate steps to stop harm from spreading, in order. Prefer reversible
actions (revoke a capability, pause a job, flip `isCurrent` back) over
destructive ones. State what each step does NOT touch.

## Recovery

Steps to restore correct service, in order, with the exact commands or
queries (parameterized; no secrets inline). Reference the owning code or
ADR, not tribal knowledge.

## Verification

How to prove recovery worked: the exact read-back (API call, query,
dashboard) and the expected value. Never close the incident on "looks
fine" — cite the check output.

## Rollback

How to undo the recovery itself if it makes things worse. Must be safe
to run twice (idempotent) and must never delete product data unless the
runbook explicitly justifies it and names the backup first.

## Escalation

Who/what is next when this runbook is insufficient: on-call path, venue
for the decision (e.g. manual approval gate per BUILD_SPEC §17
`deploy-production.yml`), and what evidence to bring (trace IDs,
timestamps, redacted logs — never raw tokens or secrets).
```

## Worked pointers (this repo)

- Detection example: hourly freshness check warning when the current
  run is > 24 h old (`docs/runbooks/stale-data.md`).
- Containment + recovery without deletion: repoint `isCurrent` between
  retained runs (`docs/runbooks/failed-publish-rollback.md`).
- Verification example: `meta.projectionRunId` changes to the target run
  ID on `GET /api/v1/rankings`.
- Rollback example: re-flip the pointer; revoke the bad override so the
  next publish does not reproduce the fault.
- Escalation: production deploys require manual approval and a
  pre-deploy backup (BUILD_SPEC §17) — planned, not provisioned
  (`docs/architecture/05-deployment-topology.md`).

## Sources

- `BUILD_SPEC.md` §17, §19
- `docs/runbooks/stale-data.md`
- `docs/runbooks/failed-publish-rollback.md`
- `docs/runbooks/share-revocation-cleanup.md`
- `docs/runbooks/source-disable.md`
- `docs/architecture/05-deployment-topology.md`
