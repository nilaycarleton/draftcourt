import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "@/lib/server/circuit-breaker";
import { createAnalyticsClient } from "@/lib/server/analytics-client";

const BASE_URL = "http://analytics.test";
const SECRET = "test-secret";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function jobPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job-1",
    kind: "PROJECTION_RUN",
    status: "SUCCEEDED",
    result: { runId: "run-1" },
    errorCode: null,
    traceId: "t-1",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("analytics-client", () => {
  let captured: CapturedRequest[];

  beforeEach(() => {
    captured = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeClient(
    responder: (req: CapturedRequest) => Response | Promise<Response>,
    breaker = new CircuitBreaker(3, 1000),
  ) {
    return createAnalyticsClient({
      baseUrl: BASE_URL,
      serviceSecret: SECRET,
      breaker,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        const request = { url: String(url), init: init ?? {} };
        captured.push(request);
        return responder(request);
      }) as typeof fetch,
    });
  }

  it("signs every request with bearer secret and a fresh timestamp", async () => {
    const client = makeClient(() => jsonResponse(200, jobPayload()));
    const result = await client.postJob("/internal/v1/projections/run", {
      body: { reason: "test" },
    });
    expect(result.ok).toBe(true);
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
    const rawTimestamp = headers.get("X-Request-Timestamp");
    expect(rawTimestamp).not.toBeNull();
    const timestamp = Number(rawTimestamp);
    const expectedEpoch = Math.floor(new Date("2026-08-22T12:00:00Z").getTime() / 1000);
    expect(Math.abs(timestamp - expectedEpoch)).toBeLessThanOrEqual(1);
    expect(captured[0]?.url).toBe(`${BASE_URL}/internal/v1/projections/run`);
  });

  it("propagates trace id and idempotency key", async () => {
    const client = makeClient(() => jsonResponse(200, jobPayload()));
    await client.postJob("/internal/v1/projections/run", {
      idempotencyKey: "nightly-publish-2026-08-22",
      traceId: "trace-abc",
    });
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("Idempotency-Key")).toBe("nightly-publish-2026-08-22");
    expect(headers.get("X-Trace-Id")).toBe("trace-abc");
    void headers;
  });

  it("maps 409 to conflict without counting breaker failure", async () => {
    const breaker = new CircuitBreaker(2, 1000);
    const client = makeClient(() => jsonResponse(409, { detail: "job already running" }), breaker);
    const result = await client.postJob("/internal/v1/projections/run");
    expect(result).toMatchObject({ ok: false, kind: "conflict" });
    expect(breaker.isOpen).toBe(false);
  });

  it("counts network failures toward the breaker and short-circuits when open", async () => {
    const breaker = new CircuitBreaker(2, 5_000);
    const client = makeClient(() => {
      throw new Error("ECONNREFUSED");
    }, breaker);

    const first = await client.postJob("/internal/v1/projections/run");
    const second = await client.postJob("/internal/v1/projections/run");
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(breaker.isOpen).toBe(true);
    expect(captured).toHaveLength(2);

    const third = await client.postJob("/internal/v1/projections/run");
    expect(third).toMatchObject({ ok: false, kind: "unavailable" });
    if (third.ok) throw new Error("expected failure result");
    expect(third.detail).toContain("circuit breaker open");
    expect(captured).toHaveLength(2);
  });

  it("parses problem details from rejection responses", async () => {
    const client = makeClient(() =>
      jsonResponse(404, { detail: "unsupported ingestion source 'espn'" }),
    );
    const result = await client.postJob("/internal/v1/ingestion/espn");
    expect(result).toMatchObject({
      ok: false,
      kind: "rejected",
      status: 404,
      detail: "unsupported ingestion source 'espn'",
    });
  });

  it("surfaces TIMEOUT state as kind timeout", async () => {
    const client = makeClient(() =>
      jsonResponse(504, { detail: "job exceeded timeout" }, { "X-Job-Id": "job-timeout" }),
    );
    const result = await client.postJob("/internal/v1/projections/run");
    expect(result).toMatchObject({ ok: false, kind: "timeout", jobId: "job-timeout" });
  });

  it("returns recorded state for duplicate deliveries (idempotent replay)", async () => {
    const client = makeClient((request) => {
      const headers = new Headers(request.init.headers);
      if (!headers.get("Idempotency-Key")) {
        return jsonResponse(500, { detail: "test expects a key" });
      }
      return jsonResponse(200, jobPayload({ status: "SUCCEEDED" }), {
        "X-Idempotent-Replay": "true",
      });
    });
    const options = { idempotencyKey: "nightly-ingest-2026-08-22" };
    await client.postJob("/internal/v1/ingestion/demo-file", options);
    const replay = await client.postJob("/internal/v1/ingestion/demo-file", options);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unreachable");
    expect(replay.data.status).toBe("SUCCEEDED");
  });

  it("getJob hits the jobs endpoint with signed headers", async () => {
    const client = makeClient(() => jsonResponse(200, jobPayload()));
    const result = await client.getJob("some-job-id");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.jobId).toBe("job-1");
    expect(captured[0]?.url).toBe(`${BASE_URL}/internal/v1/jobs/some-job-id`);
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
  });
});
