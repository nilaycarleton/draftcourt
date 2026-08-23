import { CircuitBreaker } from "@/lib/server/circuit-breaker";
import { env } from "@/lib/env";

/**
 * The web → analytics service client — the first real inter-service HTTP
 * call site, which is also where ADR 0008's circuit breaker finally wires
 * in. Every request is signed the way `app/core/security.py` (analytics)
 * verifies it:
 *
 * - `Authorization: Bearer <ANALYTICS_SERVICE_SECRET>` (shared secret;
 *   rotation = redeploying both services);
 * - `X-Request-Timestamp` unix seconds — rejected by analytics outside a
 *   ±300s replay window;
 * - optional `Idempotency-Key`, mapped to exactly one `analytics_jobs` row
 *   per job kind server-side (duplicate delivery replays the recorded
 *   outcome instead of re-running the pipeline);
 * - `X-Trace-Id`, propagated into job rows, logs, and responses.
 *
 * Results are a discriminated union rather than thrown exceptions: callers
 * (Inngest functions) decide what "unavailable" means for them (retry with
 * backoff, fall back to the last published run, or surface degraded state).
 * The breaker short-circuits to `{ ok: false, kind: "unavailable" }` after
 * repeated consecutive failures and half-opens after the reset window.
 */

export type AnalyticsFailureKind =
  | "unavailable" // breaker open, network error, or abort/timeout
  | "rejected" // 401 auth problem, 404 unknown route/source, 422 validation
  | "conflict" // 409 — same-kind job already running; poll jobs instead
  | "timeout"; // 504 — analytics marked the job TIMEOUT

export interface AnalyticsJobRequestOptions {
  body?: { reason?: string; schemaVersion?: string };
  idempotencyKey?: string | undefined;
  traceId?: string;
  timeoutMs?: number;
}

export type AnalyticsCallResult<T> =
  | { ok: true; status: number; jobId?: string; data: T }
  | {
      ok: false;
      kind: AnalyticsFailureKind;
      status?: number;
      jobId?: string;
      detail: string;
    };

export interface AnalyticsClientOptions {
  /** Override in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  breaker?: CircuitBreaker;
  baseUrl?: string;
  serviceSecret?: string;
}

interface AnalyticsInternalJobResponse {
  jobId: string;
  kind: string;
  status: string;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  traceId: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class AnalyticsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly breaker: CircuitBreaker;
  private readonly baseUrl: string;
  private readonly serviceSecret: string;

  constructor(options: AnalyticsClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.breaker = options.breaker ?? new CircuitBreaker(3, 60_000);
    this.baseUrl = options.baseUrl ?? env.ANALYTICS_BASE_URL;
    this.serviceSecret = options.serviceSecret ?? env.ANALYTICS_SERVICE_SECRET;
  }

  /**
   * POST to an internal job endpoint (`/internal/v1/...`). Never throws:
   * failures come back as `{ ok: false }`. Every failed call counts toward
   * the circuit breaker; an open breaker short-circuits to
   * `{ ok: false, kind: "unavailable" }` without touching the network.
   */
  postJob(
    path: string,
    options: {
      body?: { reason?: string; schemaVersion?: string };
      idempotencyKey?: string;
      traceId?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<AnalyticsCallResult<AnalyticsInternalJobResponse>> {
    return this.run(() => this.execute("POST", path, options));
  }

  getJob(
    jobId: string,
    traceId?: string,
  ): Promise<AnalyticsCallResult<AnalyticsInternalJobResponse>> {
    return this.run(() =>
      this.executeGet(`/internal/v1/jobs/${encodeURIComponent(jobId)}`, traceId),
    );
  }

  private async run(
    call: () => Promise<AnalyticsCallResult<AnalyticsInternalJobResponse>>,
  ): Promise<AnalyticsCallResult<AnalyticsInternalJobResponse>> {
    if (this.breaker.isOpen) {
      return {
        ok: false,
        kind: "unavailable",
        detail: "analytics service unreachable (circuit breaker open)",
      };
    }
    const result = await call();
    if (result.ok) {
      this.breaker.recordSuccess();
    } else {
      // Auth/validation problems are deterministic rejections, not
      // dependency health — they must not trip the breaker.
      if (result.kind !== "rejected") this.breaker.recordFailure();
    }
    return result;
  }

  private async execute(
    method: "POST",
    path: string,
    options: {
      body?: { reason?: string; schemaVersion?: string };
      idempotencyKey?: string;
      traceId?: string;
      timeoutMs?: number;
    },
  ): Promise<AnalyticsCallResult<AnalyticsInternalJobResponse>> {
    const headers = this.signedHeaders(options.traceId);
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(options.body ?? {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      return {
        ok: false,
        kind: "unavailable",
        detail: "analytics service did not respond before the request timeout",
      };
    }
    return this.parse(response);
  }

  private async executeGet(
    path: string,
    traceId?: string,
  ): Promise<AnalyticsCallResult<AnalyticsInternalJobResponse>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.signedHeaders(traceId),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch {
      return {
        ok: false,
        kind: "unavailable",
        detail: "analytics service did not respond before the request timeout",
      };
    }
    return this.parse(response);
  }

  private signedHeaders(traceId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.serviceSecret}`,
      // Fresh timestamp per attempt — an old one would be rejected by the
      // analytics replay window even if the secret were valid.
      "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
    };
    if (traceId) headers["X-Trace-Id"] = traceId;
    return headers;
  }

  private async parse(
    response: Response,
  ): Promise<AnalyticsCallResult<AnalyticsInternalJobResponse>> {
    const jobIdHeader = response.headers.get("X-Job-Id") ?? undefined;

    interface ProblemBody {
      type?: string;
      title?: string;
      status?: number;
      detail?: string;
      traceId?: string;
    }

    let body: (ProblemBody & Partial<AnalyticsInternalJobResponse>) | undefined;
    try {
      body = (await response.json()) as ProblemBody & Partial<AnalyticsInternalJobResponse>;
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const kind: AnalyticsFailureKind =
        response.status === 409
          ? "conflict"
          : response.status === 504
            ? "timeout"
            : response.status === 401 || response.status === 404 || response.status === 422
              ? "rejected"
              : "unavailable";
      const jobId = body?.jobId ?? jobIdHeader;
      return {
        ok: false,
        kind,
        status: response.status,
        ...(jobId !== undefined ? { jobId } : {}),
        detail:
          body?.detail ?? `analytics responded ${String(response.status)} ${response.statusText}`,
      };
    }

    if (!body || typeof body.jobId !== "string" || typeof body.status !== "string") {
      return {
        ok: false,
        kind: "unavailable",
        status: response.status,
        detail: "analytics returned a malformed job payload",
      };
    }

    return {
      ok: true,
      status: response.status,
      jobId: body.jobId,
      data: body as AnalyticsInternalJobResponse,
    };
  }
}

/** Process-wide client used by Inngest functions. */
export const analyticsClient = new AnalyticsClient();

/** Test seam — build an isolated client with explicit dependencies. */
export function createAnalyticsClient(options: AnalyticsClientOptions = {}): AnalyticsClient {
  return new AnalyticsClient(options);
}
