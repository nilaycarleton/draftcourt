import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * Loads the repo root .env.local into process.env. Used by both
 * prisma.config.ts (so `prisma migrate`/`prisma generate` see DATABASE_URL)
 * and prisma/seed.ts (which tsx runs directly, bypassing Prisma's own
 * config-loading step) — one implementation instead of two copies that
 * could drift.
 */
export function loadRootEnv(): void {
  const rootEnvLocal = resolve(import.meta.dirname, "../../../.env.local");
  if (existsSync(rootEnvLocal)) {
    loadEnv({ path: rootEnvLocal });
  }
}
