import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { prisma } from "@draftcourt/db";

/**
 * Signed-webhook tests for POST /api/v1/webhooks/clerk, hitting the real
 * Postgres like the other database-backed unit tests in this package.
 * Signatures are produced with the same svix library the route verifies
 * with (standardwebhooks scheme), so tampering/replay paths are exercised
 * for real rather than with a mocked verifier.
 */

// svix secrets must be base64 (standardwebhooks scheme) after the whsec_
// prefix - this is base64 of "0123456789abcdef0123456789abcdef".
const SIGNING_SECRET = "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

vi.mock("@/lib/env", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    env: {
      ...(actual.env as Record<string, unknown>),
      CLERK_WEBHOOK_SIGNING_SECRET: SIGNING_SECRET,
    },
    isClerkConfigured: true,
  };
});

const createdUserIds: string[] = [];

async function cleanup() {
  if (createdUserIds.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  // Events for unknown clerk ids never create rows but may write audit rows.
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: "clerk." } } });
}

function signPayload(eventType: string, data: Record<string, unknown>) {
  const payload = JSON.stringify({ type: eventType, data });
  const signer = new Webhook(SIGNING_SECRET);
  const msgId = `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const signature = signer.sign(msgId, timestamp, payload);
  return {
    payload,
    headers: {
      "content-type": "application/json",
      "svix-id": msgId,
      "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "svix-signature": signature,
    },
  };
}

async function postWebhook(
  eventType: string,
  data: Record<string, unknown>,
  mutate?: (headers: Record<string, string>) => void,
): Promise<Response> {
  const { payload, headers } = signPayload(eventType, data);
  mutate?.(headers);
  const { POST } = await import("@/app/api/v1/webhooks/clerk/route");
  return POST(
    new Request("http://localhost:3100/api/v1/webhooks/clerk", {
      method: "POST",
      body: payload,
      headers,
    }),
  );
}

const clerkUserId = `user_test_${Math.random().toString(36).slice(2)}`;

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe("POST /api/v1/webhooks/clerk", () => {
  it("creates a mirrored user on user.created and is idempotent on redelivery", async () => {
    const first = await postWebhook("user.created", { id: clerkUserId });
    expect(first.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
    createdUserIds.push(user.id);
    expect(user.role).toBe("USER");

    const second = await postWebhook("user.created", { id: clerkUserId });
    expect(second.status).toBe(200);
    const users = await prisma.user.findMany({ where: { clerkUserId } });
    // redelivery must not duplicate the mirror row
    expect(users).toHaveLength(1);
  });

  it("grants ADMIN only via server-managed publicMetadata and re-syncs on update", async () => {
    await postWebhook("user.created", { id: clerkUserId });
    let user = await prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
    createdUserIds.push(user.id);
    expect(user.role).toBe("USER");

    // Server-side promotion through Clerk Backend API metadata.
    await postWebhook("user.updated", {
      id: clerkUserId,
      public_metadata: { draftcourtRole: "ADMIN" },
    });
    user = await prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
    expect(user.role).toBe("ADMIN");

    // Demotion also syncs; unsafeMetadata (client-writable) is ignored.
    await postWebhook("user.updated", {
      id: clerkUserId,
      public_metadata: {},
      unsafe_metadata: { draftcourtRole: "ADMIN" },
    });
    user = await prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
    expect(user.role).toBe("USER");
  });

  it("rejects a tampered payload with 401 without touching the database", async () => {
    const response = await postWebhook("user.created", { id: clerkUserId }, (headers) => {
      headers["svix-signature"] = "v1,tampered";
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("/problems/unauthorized");
    expect(await prisma.user.findUnique({ where: { clerkUserId } })).toBeNull();

    const staleTimestamp = Math.floor(Date.now() / 1000) - 60 * 60 * 6;
    const response2 = await postWebhook("user.created", { id: clerkUserId }, (headers) => {
      headers["svix-timestamp"] = String(staleTimestamp);
    });
    // svix's tolerance check rejects ancient timestamps (replay protection).
    expect(response2.status).toBe(401);
  });

  it("answers 503 when Clerk is unconfigured instead of processing events", async () => {
    const { createClerkWebhookHandler } = await import("@/app/api/v1/webhooks/clerk/route");
    const unconfiguredPost = createClerkWebhookHandler({ signingSecret: "" });
    const request = new Request("http://localhost/api/v1/webhooks/clerk", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    const response = await unconfiguredPost(request);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("/problems/service-unavailable");
  });

  it("audits mirror changes redacted - no email/name ever persisted", async () => {
    await postWebhook("user.created", {
      id: clerkUserId,
      email_addresses: [{ email_address: "secret.person@example.com" }],
      first_name: "Secret",
      last_name: "Person",
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
    createdUserIds.push(user.id);

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "User", entityId: user.id },
    });
    expect(audits.length).toBeGreaterThan(0);
    for (const entry of audits) {
      const serialized = JSON.stringify(entry.beforeJson) + JSON.stringify(entry.afterJson);
      expect(serialized).not.toContain("example.com");
      expect(serialized).not.toContain("Secret");
    }
  });

  it("records user.deleted as an audit event without deleting the row", async () => {
    await postWebhook("user.created", { id: clerkUserId });
    const user = await prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
    createdUserIds.push(user.id);

    const response = await postWebhook("user.deleted", { id: clerkUserId });
    expect(response.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { clerkUserId } })).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "clerk.user.deleted", entityId: clerkUserId },
    });
    expect(audit).not.toBeNull();
  });
});
