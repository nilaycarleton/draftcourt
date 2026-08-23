import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const requiredBase = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/draftcourt",
  DIRECT_DATABASE_URL: "postgresql://user:pass@localhost:5432/draftcourt",
  ANALYTICS_BASE_URL: "http://localhost:8000",
  ANALYTICS_SERVICE_SECRET: "test-secret",
};

describe("parseEnv", () => {
  it("parses a minimal valid environment with no optional integrations set", () => {
    const env = parseEnv(requiredBase);
    expect(env.CLERK_SECRET_KEY).toBe("");
    expect(env.SENTRY_DSN).toBe("");
    expect(env.AI_ASSISTANT_ENABLED).toBe(false);
    expect(env.PUBLIC_DEMO_ENABLED).toBe(true);
  });

  it("throws a readable error when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _omit, ...rest } = requiredBase;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("throws when NEXT_PUBLIC_APP_URL is not a valid URL", () => {
    expect(() => parseEnv({ ...requiredBase, NEXT_PUBLIC_APP_URL: "not-a-url" })).toThrow();
  });

  it("allows Clerk/Sentry/Inngest/OpenAI to be fully unset (disabled integrations)", () => {
    expect(() => parseEnv(requiredBase)).not.toThrow();
  });
});
