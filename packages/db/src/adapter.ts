import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Prisma 7's stable client generator requires an explicit driver adapter —
 * it no longer bundles a query engine binary by default (see
 * docs/adr/0002-postgres-and-prisma-ownership.md). This is the one place
 * that constructs it so `DATABASE_URL` is only read from the environment in
 * a single spot.
 */
export function createDriverAdapter(databaseUrl: string = mustGetDatabaseUrl()): PrismaPg {
  return new PrismaPg({ connectionString: databaseUrl });
}

function mustGetDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to construct the Prisma driver adapter.");
  }
  return url;
}
