import { auth } from "@clerk/nextjs/server";
import { prisma } from "@draftcourt/db";
import { isClerkConfigured } from "@/lib/env";

export interface CurrentUser {
  id: string;
  clerkUserId: string;
  role: "USER" | "ADMIN";
}

/**
 * Resolves the signed-in user from Clerk's session down to our own `User`
 * row (never trusting a client-supplied role claim). A small, directly
 * mockable seam — route handlers and Vitest both call this function rather
 * than touching `@clerk/nextjs/server` or Prisma directly.
 *
 * Returns `null` whenever there's no authenticated admin-eligible user:
 * Clerk isn't configured (this dev/demo environment has no real keys — see
 * lib/env.ts), there's no active session, or the session's Clerk user has
 * no matching `User` row yet (user-sync-on-first-login is out of Phase 1's
 * scope; see docs/adr/0009-admin-authorization.md).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!isClerkConfigured) return null;

  const { userId } = await auth();
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { clerkUserId: userId },
    select: { id: true, clerkUserId: true, role: true },
  });
  return user;
}

/** `null` when the caller is unauthenticated OR authenticated-but-not-admin
 * — callers that need to distinguish 401 from 403 should call
 * `getCurrentUser()` directly instead. */
export async function requireAdmin(): Promise<CurrentUser | null> {
  const user = await getCurrentUser();
  return user?.role === "ADMIN" ? user : null;
}
