import { expect, test } from "@playwright/test";

test("home page renders and links to the product tour", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DraftCourt" })).toBeVisible();
  await expect(page.getByText("Phase 3 — Live drafts + analysis")).toBeVisible();
  await expect(page.getByRole("link", { name: "Try a demo mock" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Players" })).toBeVisible();
});

interface HealthResponse {
  data: { status: string; service: string };
}

test("health endpoint reports ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as HealthResponse;
  expect(body.data.status).toBe("ok");
  expect(body.data.service).toBe("web");
});

test("security headers are present", async ({ request }) => {
  const response = await request.get("/");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
});
