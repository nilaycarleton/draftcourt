import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.PORT ?? "3100";
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] } },
    { name: "chromium-light", use: { ...devices["Desktop Chrome"], colorScheme: "light" } },
  ],
  webServer: {
    command: "pnpm start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { PORT },
  },
});
