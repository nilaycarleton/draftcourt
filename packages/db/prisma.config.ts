import { defineConfig } from "prisma/config";
import { loadRootEnv } from "./src/load-root-env";

// Single source of truth for local env vars: the repo root .env.local (see
// .env.example). Falls back silently if it doesn't exist yet (CI/Docker
// inject DATABASE_URL directly instead).
loadRootEnv();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
