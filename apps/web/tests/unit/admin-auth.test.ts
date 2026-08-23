import { describe, expect, it } from "vitest";
import { getCurrentUser, requireAdmin } from "@/lib/server/auth";

/**
 * This test env (like every local/CI env without real Clerk secrets — see
 * lib/env.ts::isClerkConfigured) has no Clerk keys configured, so
 * `getCurrentUser()` takes its "no session possible" short-circuit
 * unconditionally. That branch is exactly what a real anonymous visitor
 * hits in this deployment today, so it's real coverage, not a stub — but
 * the "authenticated admin" / "authenticated non-admin" branches inside
 * `getCurrentUser()` can only be exercised with real Clerk keys configured
 * (a `@clerk/testing` E2E session, deferred to the Phase 1 E2E suite), not
 * from this unit test.
 */
describe("getCurrentUser / requireAdmin (Clerk unconfigured)", () => {
  it("getCurrentUser returns null with no Clerk keys configured", async () => {
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("requireAdmin returns null with no Clerk keys configured", async () => {
    await expect(requireAdmin()).resolves.toBeNull();
  });
});
