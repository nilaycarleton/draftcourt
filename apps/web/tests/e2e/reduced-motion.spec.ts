import { expect, test } from "@playwright/test";

test.describe("reduced motion", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("motion durations collapse to near-zero on the players page", async ({ page }) => {
    await page.goto("/players");
    const duration = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--dc-motion-duration-default")
        .trim(),
    );
    expect(duration).toBe("1ms");
  });

  test("the score-bar fill transition is disabled on a player profile", async ({ page }) => {
    await page.goto("/players/cade-cunningham");
    const duration = await page.evaluate(() => {
      const bar = document.querySelector(".dc-score-bar-fill");
      return bar ? getComputedStyle(bar).transitionDuration : null;
    });
    expect(duration).toBe("0.001s");
  });
});
