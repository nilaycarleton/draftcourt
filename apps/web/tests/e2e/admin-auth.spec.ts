import { expect, test } from "@playwright/test";

/**
 * Full authenticated-admin E2E coverage (`@clerk/testing`) is deferred —
 * see docs/adr/0009-admin-authorization.md: no Clerk-user-sync webhook
 * exists yet, so a real Clerk session can never resolve to an admin `User`
 * row in this environment regardless of test tooling. What IS real and
 * testable here is the anonymous-access gate every `/admin/*` page and
 * `/api/v1/admin/*` route enforces.
 */
test.describe("admin access without a session", () => {
  for (const path of ["/admin/projections", "/admin/signals", "/admin/audit-log"]) {
    test(`${path} shows a sign-in-required gate, not the admin UI`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByText("Sign-in required")).toBeVisible();
      await expect(page.getByText("Create override")).toHaveCount(0);
    });
  }

  test("admin API routes return 401, never the underlying data", async ({ request }) => {
    const response = await request.get("/api/v1/admin/audit-log");
    expect(response.status()).toBe(401);
    const body = (await response.json()) as { data: unknown; error: { status: number } };
    expect(body.data).toBeNull();
    expect(body.error.status).toBe(401);
  });
});
