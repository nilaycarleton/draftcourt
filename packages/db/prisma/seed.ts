import { PrismaClient } from "../generated/client/client";
import { createDriverAdapter } from "../src/adapter";
import { loadRootEnv } from "../src/load-root-env";

// tsx runs this file directly (both `pnpm --filter @draftcourt/db run seed`
// and Prisma's own `migrate`/`db seed` hook), bypassing prisma.config.ts's
// own env loading — load it here too so DATABASE_URL is always present.
loadRootEnv();

/**
 * Deterministic Phase 0 demo seed. Only a single demo admin user exists —
 * enough to prove the migrate → seed pipeline end to end. Player/league/draft
 * seed data ships with the Phase 1 data model.
 */
const DEMO_ADMIN_CLERK_USER_ID = "user_demo_phase0_admin";

async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: createDriverAdapter() });
  try {
    const admin = await prisma.user.upsert({
      where: { clerkUserId: DEMO_ADMIN_CLERK_USER_ID },
      update: {},
      create: {
        clerkUserId: DEMO_ADMIN_CLERK_USER_ID,
        role: "ADMIN",
        plan: "free",
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded demo admin user ${admin.id}`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
