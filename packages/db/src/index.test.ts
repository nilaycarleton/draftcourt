import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./index";

/**
 * Integration test against the local Docker Compose Postgres (see
 * docker-compose.yml and .env.example). Requires DATABASE_URL to be set and
 * migrations to have already been applied — run `pnpm db:migrate` first.
 */
describe("User model", () => {
  const clerkUserId = `test_${randomUUID()}`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { clerkUserId } });
    await prisma.$disconnect();
  });

  it("round-trips a user through create/read with UUIDv7 defaults", async () => {
    const created = await prisma.user.create({
      data: { clerkUserId },
    });

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(created.role).toBe("USER");
    expect(created.plan).toBe("free");

    const found = await prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
    expect(found.id).toBe(created.id);
  });

  it("enforces the unique clerkUserId constraint", async () => {
    await prisma.user.create({ data: { clerkUserId: `${clerkUserId}_dup` } });
    await expect(
      prisma.user.create({ data: { clerkUserId: `${clerkUserId}_dup` } }),
    ).rejects.toThrow();
    await prisma.user.deleteMany({ where: { clerkUserId: `${clerkUserId}_dup` } });
  });
});
