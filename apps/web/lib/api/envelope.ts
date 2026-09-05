import { NextResponse } from "next/server";

/**
 * The `{ data, error, meta }` response envelope every `/api/v1/*` route
 * uses (BUILD_SPEC.md section 8), extending the pattern already
 * established by `/api/health` (see apps/web/app/api/health/route.ts).
 * Errors use an RFC 9457 ("Problem Details for HTTP APIs") shaped object
 * as `error` — see problem-details.ts.
 */

export interface ApiMeta {
  traceId: string;
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  data: T;
  error: null;
  meta: ApiMeta;
}

export interface ProblemDetails {
  /** A URI reference identifying the problem type. Kept as a stable slug
   * path under /problems/ rather than a dereferenceable document — no
   * public API docs site exists yet to host RFC 9457 type definitions. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Field-level validation errors, when `type` is the validation problem. */
  errors?: Record<string, string[]>;
  /** Authoritative draft state attached to version-conflict problems so
   * clients can reconcile without a second read (BUILD_SPEC section 4.4). */
  authoritative?: Record<string, unknown>;
}

export interface ApiError {
  data: null;
  error: ProblemDetails;
  meta: ApiMeta;
}

export function newTraceId(): string {
  return crypto.randomUUID();
}

export function ok<T>(
  data: T,
  meta: Omit<ApiMeta, "traceId"> & { traceId?: string } = {},
): NextResponse<ApiSuccess<T>> {
  const { traceId = newTraceId(), ...rest } = meta;
  return NextResponse.json({ data, error: null, meta: { traceId, ...rest } });
}

export function problem(
  details: ProblemDetails,
  meta: Omit<ApiMeta, "traceId"> & { traceId?: string } = {},
): NextResponse<ApiError> {
  const { traceId = newTraceId(), ...rest } = meta;
  return NextResponse.json(
    { data: null, error: details, meta: { traceId, ...rest } },
    { status: details.status },
  );
}

export const problems = {
  badRequest: (detail: string, errors?: Record<string, string[]>): ProblemDetails => ({
    type: "/problems/bad-request",
    title: "Bad Request",
    status: 400,
    detail,
    ...(errors ? { errors } : {}),
  }),
  validation: (
    errors: Record<string, string[]>,
    detail = "Request validation failed.",
  ): ProblemDetails => ({
    type: "/problems/validation-error",
    title: "Validation Error",
    status: 422,
    detail,
    errors,
  }),
  unauthorized: (detail = "Authentication is required."): ProblemDetails => ({
    type: "/problems/unauthorized",
    title: "Unauthorized",
    status: 401,
    detail,
  }),
  forbidden: (detail = "You do not have access to this resource."): ProblemDetails => ({
    type: "/problems/forbidden",
    title: "Forbidden",
    status: 403,
    detail,
  }),
  notFound: (detail = "The requested resource was not found."): ProblemDetails => ({
    type: "/problems/not-found",
    title: "Not Found",
    status: 404,
    detail,
  }),
  conflict: (detail: string): ProblemDetails => ({
    type: "/problems/conflict",
    title: "Conflict",
    status: 409,
    detail,
  }),
  internal: (detail = "An unexpected error occurred."): ProblemDetails => ({
    type: "/problems/internal-error",
    title: "Internal Server Error",
    status: 500,
    detail,
  }),
};
