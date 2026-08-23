import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runNightlyIngestAndPublish,
  runOnDemandPublish,
  utcDateKey,
} from "@/lib/inngest/functions/nightly-refresh";
import type { AnalyticsCallResult, AnalyticsClient } from "@/lib/server/analytics-client";

type PostJobArgs = Parameters<AnalyticsClient["postJob"]>;

function jobOk(result: Record<string, unknown> = {}): AnalyticsCallResult<{
  jobId: string;
  kind: string;
  status: string;
  result: Record<string, unknown> | null;
  errorCode: string | null;
}> {
  return {
    ok: true,
    status: 200,
    jobId: "job-x",
    data: { jobId: "job-x", kind: "K", status: "SUCCEEDED", result, errorCode: null },
  };
}

function stubClient(responses: AnalyticsCallResult<unknown>[]): {
  client: AnalyticsClient;
  calls: PostJobArgs[];
} {
  const calls: PostJobArgs[] = [];
  let index = 0;
  const client = {
    postJob: (path: string, options?: Parameters<AnalyticsClient["postJob"]>[1]) => {
      void path;
      calls.push([path, options] as PostJobArgs);
      return Promise.resolve(responses[Math.min(index++, responses.length - 1)]);
    },
    getJob: () => Promise.reject(new Error("not used")),
  } as unknown as AnalyticsClient;
  return { client, calls };
}

describe("nightly-refresh workflow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ingests then publishes, deriving keys from UTC date", async () => {
    const { client, calls } = stubClient([
      jobOk({ recordsPublished: 230 }),
      jobOk({ runId: "run-9" }),
    ]);
    const outcome = await runNightlyIngestAndPublish(client, new Date("2026-08-22T06:00:00Z"));
    expect(outcome).toEqual({
      ingestionJobId: "job-x",
      ingestion: { recordsPublished: 230 },
      publishJobId: "job-x",
      publishRunId: "run-9",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe("/internal/v1/ingestion/demo-file");
    expect(calls[0]?.[1]?.idempotencyKey).toBe("nightly-ingest-2026-08-22");
    expect(calls[1]?.[0]).toBe("/internal/v1/projections/run");
    expect(calls[1]?.[1]?.idempotencyKey).toBe("nightly-publish-2026-08-22");
  });

  it("does not publish when ingestion fails, and throws to trigger retry", async () => {
    const { client, calls } = stubClient([
      { ok: false, kind: "unavailable", detail: "analytics down" },
    ]);
    await expect(runNightlyIngestAndPublish(client)).rejects.toThrow(/nightly ingestion failed/);
    // publish must be skipped after a failed ingest
    expect(calls).toHaveLength(1);
  });

  it("throws when a job ends in a non-SUCCEEDED state", async () => {
    const { client } = stubClient([
      {
        ok: true,
        status: 200,
        jobId: "job-t",
        data: {
          jobId: "job-t",
          kind: "INGESTION",
          status: "TIMEOUT",
          result: null,
          errorCode: "JOB_TIMEOUT",
        },
      },
    ]);
    await expect(runNightlyIngestAndPublish(client)).rejects.toThrow(/TIMEOUT/);
  });

  it("on-demand publish passes reason and optional key", async () => {
    const { client, calls } = stubClient([jobOk({ runId: "run-od" })]);
    const result = await runOnDemandPublish("after override", client, "manual-key");
    expect(result).toEqual({ jobId: "job-x", runId: "run-od" });
    expect(calls[0]?.[1]?.body?.reason).toBe("after override");
    expect(calls[0]?.[1]?.idempotencyKey).toBe("manual-key");
  });
});

describe("utcDateKey", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(utcDateKey(new Date("2026-08-22T23:30:00Z"))).toBe("2026-08-22");
    expect(utcDateKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});
