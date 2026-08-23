import { inngest } from "@/lib/inngest/client";
import { analyticsClient } from "@/lib/server/analytics-client";
import type { AnalyticsClient, AnalyticsCallResult } from "@/lib/server/analytics-client";

/**
 * The real scheduled refresh/publish workflows ADR 0008 documented as
 * missing. Each Inngest step calls the analytics service's authenticated
 * internal HTTP API (`/internal/v1/*`) — the same endpoints a local CLI run
 * exercises — never a shell-out and never a logged-but-fake success.
 *
 * Source-mode constraint (honest scope): the only adapter that exists is
 * `demo-file` (deterministic synthetic dataset). The nightly cron therefore
 * refreshes exactly that source; when permitted live adapters land in
 * Phase 4 they register their own sources/endpoints and schedules rather
 * than silently reusing this demo path.
 *
 * Retry/backoff: Inngest retries failed steps up to `retries: 3` with its
 * built-in exponential backoff; each retry sends a fresh signed request.
 * Idempotency: every attempt carries a deterministic `Idempotency-Key`
 * (`nightly-<step>-<utc date>`), so duplicate deliveries within the same
 * day replay analytics' recorded job outcome instead of re-running —
 * bounded, safe, and observable via GET /internal/v1/jobs/:id.
 */

const INGEST_PATH = "/internal/v1/ingestion/demo-file";
const PUBLISH_PATH = "/internal/v1/projections/run";
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

export function utcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function describeFailure(call: AnalyticsCallResult<unknown>, what: string): string {
  if (!call.ok) {
    const status = call.status !== undefined ? ` ${String(call.status)}` : "";
    const kind: string = call.kind;
    return `${what} failed (${kind}${status}): ${call.detail}`;
  }
  return `${what} returned an unexpected payload`;
}

export interface NightlyRefreshOutcome {
  ingestionJobId: string;
  ingestion: Record<string, unknown> | null;
  publishJobId: string | null;
  publishRunId: string | null;
}

/** Core logic, exported plain so it can be unit/integration-tested without
 * the Inngest runtime (same pattern as freshness-check.ts). */
export async function runNightlyIngestAndPublish(
  client: AnalyticsClient = analyticsClient,
  now: Date = new Date(),
): Promise<NightlyRefreshOutcome> {
  const ingest = await client.postJob(INGEST_PATH, {
    idempotencyKey: `nightly-ingest-${utcDateKey(now)}`,
    body: { reason: "nightly scheduled source refresh" },
    timeoutMs: JOB_TIMEOUT_MS,
  });
  if (!ingest.ok) {
    // Throwing inside an Inngest step triggers its retry/backoff policy.
    throw new Error(describeFailure(ingest, "nightly ingestion"));
  }
  if (ingest.data.status !== "SUCCEEDED") {
    const finalStatus: string = ingest.data.status;
    throw new Error(`nightly ingestion ended ${finalStatus} (${String(ingest.data.errorCode)})`);
  }

  const publish = await client.postJob(PUBLISH_PATH, {
    idempotencyKey: `nightly-publish-${utcDateKey(now)}`,
    body: { reason: "nightly scheduled baseline publish" },
    timeoutMs: JOB_TIMEOUT_MS,
  });
  if (!publish.ok) {
    throw new Error(describeFailure(publish, "nightly projection publish"));
  }
  if (publish.data.status !== "SUCCEEDED") {
    const publishStatus: string = publish.data.status;
    throw new Error(`nightly publish ended ${publishStatus} (${String(publish.data.errorCode)})`);
  }

  return {
    ingestionJobId: ingest.data.jobId,
    ingestion: ingest.data.result,
    publishJobId: publish.data.jobId,
    publishRunId:
      publish.data.result && typeof publish.data.result.runId === "string"
        ? publish.data.result.runId
        : null,
  };
}

/** On-demand publish — triggered by an Inngest event so a future admin-side
 * "recompute after override" flow has a real, audited trigger path without
 * exposing any browser-callable ingestion endpoint. Callers may pass an
 * explicit idempotency key to make redeliveries of the same intent replay
 * analytics' recorded outcome; without one, each trigger is a fresh job
 * (analytics' single-running-job guard still prevents pile-ups). */
export async function runOnDemandPublish(
  reason: string,
  client: AnalyticsClient = analyticsClient,
  idempotencyKey?: string,
): Promise<{ jobId: string; runId: string | null }> {
  const publish = await client.postJob(PUBLISH_PATH, {
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    body: { reason },
    timeoutMs: JOB_TIMEOUT_MS,
  });
  if (!publish.ok) {
    throw new Error(describeFailure(publish, "on-demand projection publish"));
  }
  if (publish.data.status !== "SUCCEEDED") {
    const onDemandStatus: string = publish.data.status;
    throw new Error(
      `on-demand publish ended ${onDemandStatus} (${String(publish.data.errorCode)})`,
    );
  }
  return {
    jobId: publish.data.jobId,
    runId:
      publish.data.result && typeof publish.data.result.runId === "string"
        ? publish.data.result.runId
        : null,
  };
}

export const nightlyRefreshFunction = inngest.createFunction(
  {
    id: "nightly-source-refresh-and-publish",
    triggers: [{ cron: "0 6 * * *" }],
    retries: 3,
    concurrency: { limit: 1 },
  },
  async () => {
    const outcome = await runNightlyIngestAndPublish();
    return { message: "nightly refresh complete", ...outcome };
  },
);

export const onDemandPublishFunction = inngest.createFunction(
  {
    id: "projection-publish-on-demand",
    triggers: [{ event: "analytics/projection-publish.requested" }],
    retries: 3,
    concurrency: { limit: 1 },
  },
  async ({ event }) => {
    const reason =
      typeof (event.data as { reason?: unknown }).reason === "string" &&
      (event.data as { reason: string }).reason.trim().length > 0
        ? (event.data as { reason: string }).reason.slice(0, 200)
        : "manual on-demand republish";
    const result = await runOnDemandPublish(reason);
    return { message: "publish complete", ...result };
  },
);
