import { describe, expect, it } from "vitest";
import { scrubSentryEvent } from "@/lib/sentry-redact";
import type { ErrorEvent } from "@sentry/nextjs";

function makeEvent(overrides: Partial<ErrorEvent>): ErrorEvent {
  return { ...overrides } as ErrorEvent;
}

describe("scrubSentryEvent", () => {
  it("redacts sensitive request headers", () => {
    const event = makeEvent({
      request: {
        headers: {
          Authorization: "Bearer super-secret-token",
          "User-Agent": "vitest",
        },
      },
    });

    const scrubbed = scrubSentryEvent(event, {});
    expect(scrubbed.request?.headers?.Authorization).toBe("[redacted]");
    expect(scrubbed.request?.headers?.["User-Agent"]).toBe("vitest");
  });

  it("redacts cookies entirely", () => {
    const event = makeEvent({
      request: { cookies: { session: "abc123" } },
    });

    const scrubbed = scrubSentryEvent(event, {});
    expect(scrubbed.request?.cookies).toEqual({ session: "[redacted]" });
  });

  it("redacts keys matching token/secret/prompt patterns in request data", () => {
    const event = makeEvent({
      request: {
        data: {
          shareToken: "abc",
          analyticsServiceSecret: "def",
          aiPrompt: "tell me a secret",
          playerName: "Placeholder Player",
        },
      },
    });

    const scrubbed = scrubSentryEvent(event, {});
    const data = scrubbed.request?.data as Record<string, unknown>;
    expect(data.shareToken).toBe("[redacted]");
    expect(data.analyticsServiceSecret).toBe("[redacted]");
    expect(data.aiPrompt).toBe("[redacted]");
    expect(data.playerName).toBe("Placeholder Player");
  });

  it("redacts email addresses found in string values", () => {
    const event = makeEvent({
      extra: { note: "contact user at nilay@example.com for follow-up" },
    });

    const scrubbed = scrubSentryEvent(event, {});
    expect(scrubbed.extra?.note).toBe("contact user at [redacted-email] for follow-up");
  });

  it("keeps the user id but redacts other user PII", () => {
    const event = makeEvent({
      user: { id: "user_123", email: "nilay@example.com" },
    });

    const scrubbed = scrubSentryEvent(event, {});
    expect(scrubbed.user?.id).toBe("user_123");
    expect(scrubbed.user?.email).toBe("[redacted]");
  });
});
