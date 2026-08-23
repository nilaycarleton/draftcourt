import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("data sources", () => {
  test("lists the demo sources with freshness and permitted uses", async ({ page }) => {
    await page.goto("/data-sources");
    await expect(page.getByRole("heading", { name: "Data sources" })).toBeVisible();
    await expect(page.getByText("demo-file-adapter")).toBeVisible();
    await expect(page.getByText("Succeeded").first()).toBeVisible();
  });

  test("has no serious or critical accessibility violations", async ({ page }) => {
    await page.goto("/data-sources");
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
});

test.describe("methodology", () => {
  test("documents the baseline formula and the no-endorsement disclaimer", async ({ page }) => {
    await page.goto("/methodology");
    await expect(page.getByRole("heading", { name: "Methodology" })).toBeVisible();
    await expect(page.getByText("baseline-weighted-historical")).toBeVisible();
    await expect(page.getByText(/not endorsed by/)).toBeVisible();
  });

  test("has no serious or critical accessibility violations", async ({ page }) => {
    await page.goto("/methodology");
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
});
