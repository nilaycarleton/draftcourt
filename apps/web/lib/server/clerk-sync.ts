import { prisma, Prisma } from "@draftcourt/db";

/**
 * Clerk → `users` table mirror (BUILD_SPEC.md section 3.1: "Mirror the
 * minimum user profile into `User`; Clerk remains the identity source").
 * This closes the gap ADR 0009 recorded: without this webhook, a real
 * Clerk session could never resolve to a `User` row, so every
 * authenticated path (`getCurrentUser()`, admin gates, and Phase 2's
 * owner-scoped leagues/drafts) was unreachable in practice.
 *
 * Security model (ADR 0009 carries over):
 * - **Role assignment is server-controlled only.** `ADMIN` comes from the
 *   `publicMetadata.draftcourtRole` field, which Clerk exposes as writable
 *   exclusively through its Backend API (server-side dashboard/backend
 *   calls) — browser clients cannot modify `publicMetadata`; they can only
 *   modify `unsafeMetadata`, which this mirror deliberately ignores.
 * - **Redaction.** Audit entries record `{ clerkUserId, role }` only —
 *   never email addresses, names, phone numbers, or raw event payloads.
 * - **Idempotency.** Upserts key on `clerkUserId`, so Clerk webhook
 *   redelivery converges to the same state instead of duplicating rows.
 * - **Deletion.** `user.deleted` intentionally does NOT delete the row:
 *   audit-log entries, overrides, signals, and (in Phase 2) league/draft
 *   ownership reference it. The event is audited; account/data deletion is
 *   a documented product flow (BUILD_SPEC section 13), not a webhook
 *   side effect.
 */

export interface ClerkWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

export type SyncOutcome =
  | { handled: true; action: string; userId: string; role: "USER" | "ADMIN" | null }
  | { handled: false; reason: string };

/** Only `publicMetadata.draftcourtRole === "ADMIN"` grants the ADMIN role;
 * anything else (absent, USER, unexpected values) maps to USER. */
function roleFromMetadata(data: Record<string, unknown>): "USER" | "ADMIN" {
  const metadata = data.public_metadata as Record<string, unknown> | undefined;
  return metadata?.draftcourtRole === "ADMIN" ? "ADMIN" : "USER";
}

export async function syncClerkUserEvent(event: ClerkWebhookEvent): Promise<SyncOutcome> {
  const data = event.data;
  const clerkUserId = typeof data.id === "string" ? data.id : null;
  if (!clerkUserId) {
    return { handled: false, reason: "event payload missing user id" };
  }

  switch (event.type) {
    case "user.created":
    case "user.updated": {
      const role = roleFromMetadata(data);
      const user = await prisma.user.upsert({
        where: { clerkUserId },
        update: { role },
        create: { clerkUserId, role },
      });
      const action = `clerk.user.${event.type === "user.created" ? "created" : "updated"}`;
      await prisma.auditLog.create({
        data: {
          action,
          entityType: "User",
          entityId: user.id,
          // Redacted snapshot: identity fields stay in Clerk, never here.
          beforeJson: Prisma.JsonNull,
          afterJson: { clerkUserId, role },
          traceId: crypto.randomUUID(),
        },
      });
      return { handled: true, action, userId: user.id, role };
    }

    case "user.deleted": {
      await prisma.auditLog.create({
        data: {
          action: "clerk.user.deleted",
          entityType: "User",
          entityId: clerkUserId,
          beforeJson: { clerkUserId },
          afterJson: { retained: "row retained for ownership/audit references" },
          traceId: crypto.randomUUID(),
        },
      });
      return { handled: true, action: "clerk.user.deleted", userId: clerkUserId, role: null };
    }

    default:
      return { handled: false, reason: `unhandled event type ${event.type}` };
  }
}
