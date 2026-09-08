import type { ErrorEvent, EventHint } from "@sentry/nextjs";

/**
 * Sentry `beforeSend` hook. Strips auth headers, cookies, share tokens,
 * prompts, and email/PII from source payloads before an event ever leaves
 * the process, per BUILD_SPEC.md section 13. Kept as a pure, exported
 * function so redaction behavior is unit-testable without a live DSN — see
 * sentry-redact.test.ts.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-clerk-auth-token",
  "x-clerk-session-id",
  "x-analytics-service-secret",
]);

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|prompt|api[-_]?key|share[-_]?token|share[-_]?digest|capability[-_]?token|^email$/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

// 43-char base64url path segments are capability/share-token shaped — scrub
// them wherever they appear in free text (URLs, pathnames, breadcrumbs).
const TOKEN_SHAPED_SEGMENT = /[A-Za-z0-9_-]{43}/g;

function redactString(value: string): string {
  return value
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(TOKEN_SHAPED_SEGMENT, "[redacted-token]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = redactValue(value);
  }
  return result;
}

function redactHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return headers;
  const entries = Array.isArray(headers)
    ? (headers as [string, unknown][])
    : Object.entries(headers as Record<string, unknown>);
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    redacted[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return redacted;
}

export function scrubSentryEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  if (event.request) {
    if (event.request.headers) {
      event.request.headers = redactHeaders(event.request.headers) as Record<string, string>;
    }
    if (event.request.cookies) {
      event.request.cookies = Object.fromEntries(
        Object.keys(event.request.cookies).map((key) => [key, "[redacted]"]),
      );
    }
    if (typeof event.request.url === "string") {
      event.request.url = redactString(event.request.url);
    }
    if (event.request.data) {
      event.request.data = redactValue(event.request.data);
    }
  }

  if (event.user) {
    const { id, ...rest } = event.user;
    event.user = { ...(id !== undefined ? { id } : {}), ...redactObject(rest) };
  }

  if (event.extra) {
    event.extra = redactObject(event.extra);
  }

  if (event.contexts) {
    event.contexts = redactObject(event.contexts) as typeof event.contexts;
  }

  return event;
}
