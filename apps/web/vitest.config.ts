import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    env: {
      // Host port is 55432, not Postgres's default 5432 — see
      // docker-compose.yml ("avoids the common 5432/5433 ports").
      DATABASE_URL: "postgresql://draftcourt:draftcourt@localhost:55432/draftcourt",
      DIRECT_DATABASE_URL: "postgresql://draftcourt:draftcourt@localhost:55432/draftcourt",
      ANALYTICS_BASE_URL: "http://localhost:8000",
      ANALYTICS_SERVICE_SECRET: "test-secret",
    },
  },
});
