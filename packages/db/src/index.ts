import { PrismaClient } from "../generated/client/client";
import { createDriverAdapter } from "./adapter";

export { Prisma, PrismaClient } from "../generated/client/client";
export type * from "../generated/client/models";
export { createDriverAdapter } from "./adapter";

declare global {
  var __draftcourtPrisma: PrismaClient | undefined;
}

/**
 * Singleton PrismaClient. In dev, Next.js hot-reloads modules, which would
 * otherwise create a new client (and a new connection pool) on every edit —
 * reuse a global instance instead. See
 * https://www.prisma.io/docs/orm/more/help-and-troubleshooting/nextjs-help.
 */
export const prisma: PrismaClient =
  globalThis.__draftcourtPrisma ?? new PrismaClient({ adapter: createDriverAdapter() });

if (process.env.NODE_ENV !== "production") {
  globalThis.__draftcourtPrisma = prisma;
}
