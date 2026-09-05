import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClerkClient, type ClerkClient } from "@clerk/backend";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Test-only Clerk helpers for the authenticated E2E acceptance run.
 *
 * Security contract (BUILD_SPEC §13/§16.3, PHASE_3 Gate 0):
 * - Values of credential variables are never logged or echoed — the only
 *   inspection is a strict prefix check, and everything here refuses to run
 *   unless both keys are development/test keys and NODE_ENV is not
 *   "production", so test authentication can never point at a production
 *   Clerk instance.
 * - Nothing here weakens application authentication: the app under test
 *   always sees a real Clerk session (sign-in goes through the app's own
 *   /sign-in surface via @clerk/testing). The only seeded seam is the
 *   `users` mirror row that the signed `user.created` webhook would insert
 *   (the local webhook receiver is intentionally unconfigured → 503, see
 *   app/api/v1/webhooks/clerk/route.ts).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/web/.env.local — git-ignored, loaded by Next.js for the app itself. */
const ENV_FILE = path.join(here, "..", "..", "..", ".env.local");

export interface TestClerkCredentials {
  secretKey: string;
  publishableKey: string;
}

let cachedEnv: Record<string, string> | null = null;

function parseEnvFile(filePath: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in parsed)) parsed[key] = value;
  }
  return parsed;
}

/** Parses apps/web/.env.local once and forwards it into process.env
 * (existing values win, matching dotenv semantics). Never logs contents. */
export function loadAppEnv(): Record<string, string> {
  if (cachedEnv === null) {
    cachedEnv = parseEnvFile(ENV_FILE);
    for (const [key, value] of Object.entries(cachedEnv)) {
      if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
    }
  }
  return cachedEnv;
}

/** Hard gate: returns the dev/test credentials or refuses to run. Test
 * authentication must be impossible to enable against production. */
export function loadTestOnlyClerkCredentials(): TestClerkCredentials {
  const env = loadAppEnv();
  if (process.env.NODE_ENV === "production") {
    throw new Error("Clerk test users are not allowed when NODE_ENV is production.");
  }
  const secretKey = env.CLERK_SECRET_KEY;
  const publishableKey = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (typeof secretKey !== "string" || !secretKey.startsWith("sk_test_")) {
    throw new Error(
      "CLERK_SECRET_KEY must be present and use a Clerk development/test instance (sk_test_…).",
    );
  }
  if (typeof publishableKey !== "string" || !publishableKey.startsWith("pk_test_")) {
    throw new Error(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be present and use a Clerk development/test instance (pk_test_…).",
    );
  }
  return { secretKey, publishableKey };
}

function clerkClient(credentials: TestClerkCredentials): ClerkClient {
  return createClerkClient({ secretKey: credentials.secretKey });
}

/**
 * Signs a test user in by exchanging a short-lived Clerk SIGN-IN TOKEN
 * through the app's own mounted Clerk provider on /sign-in — the same
 * supported testing mechanism @clerk/testing uses internally for
 * email-based sign-ins. The app sees a genuine Clerk-issued session
 * (provider, middleware, CSP and __session cookies all exercised); no
 * cookies are forged and no application authentication is bypassed.
 * Deterministic: unlike the password form, this never triggers the
 * instance's new-device email-code step.
 */
export async function signInViaTicket(
  page: Page,
  credentials: TestClerkCredentials,
  userId: string,
): Promise<void> {
  const client = clerkClient(credentials);
  const signInToken = await client.signInTokens.createSignInToken({
    userId,
    expiresInSeconds: 300,
  });

  await page.goto("/sign-in");
  // window.Clerk appears before its client hydrates from the Frontend API —
  // wait for the client itself.
  await page.waitForFunction(
    () => {
      const clerkWindow = window as { Clerk?: { client?: unknown } };
      return Boolean(clerkWindow.Clerk?.client);
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(async (ticket) => {
    const clerkWindow = window as unknown as {
      Clerk?: {
        client?: {
          signIn?: {
            create: (params: { strategy: string; ticket: string }) => Promise<{
              status: string;
              createdSessionId?: string | null;
            }>;
          };
        };
        setActive?: (params: { session?: string | null | undefined }) => Promise<void>;
      };
    };
    const signIn = clerkWindow.Clerk?.client?.signIn;
    const setActive = clerkWindow.Clerk?.setActive;
    if (!signIn || !setActive) throw new Error("Clerk client not ready on /sign-in.");
    const result = await signIn.create({ strategy: "ticket", ticket });
    if (result.status !== "complete") {
      throw new Error(`Ticket sign-in did not complete (status ${result.status}).`);
    }
    await setActive({ session: result.createdSessionId });
  }, signInToken.token);

  // The session cookie is written asynchronously once Clerk finishes the
  // sign-in — wait for it directly.
  await expect
    .poll(
      async () => {
        const sessions = (await page.context().cookies()).filter((cookie) =>
          cookie.name.startsWith("__session"),
        );
        return sessions.reduce((longest, cookie) => Math.max(longest, cookie.value.length), 0);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(100);
}

/**
 * Idempotently (re)creates a verified user in the Clerk TEST instance and
 * returns its id. Existing users with the same address are deleted first so
 * reruns are deterministic. The instance under test requires a username, so
 * a unique one is supplied (timestamps keep it collision-free across runs).
 */
export async function resetClerkTestUser(
  emailAddress: string,
  password: string,
  lastName: string,
): Promise<string> {
  const credentials = loadTestOnlyClerkCredentials();
  const client = clerkClient(credentials);

  const existing = await client.users.getUserList({ emailAddress: [emailAddress], limit: 20 });
  for (const user of existing.data) {
    await client.users.deleteUser(user.id);
  }

  const created = await client.users.createUser({
    emailAddress: [emailAddress],
    password,
    firstName: "E2E",
    lastName,
    username: `e2e_${lastName.toLowerCase()}_${String(Date.now())}`,
  });

  await mirrorUserRowAfterWebhook(created.id);
  return created.id;
}

/** Best-effort cleanup; failures never fail the run (test-instance hygiene only). */
export async function deleteClerkTestUsersByEmail(emailAddress: string): Promise<void> {
  try {
    const credentials = loadTestOnlyClerkCredentials();
    const client = clerkClient(credentials);
    const existing = await client.users.getUserList({ emailAddress: [emailAddress], limit: 20 });
    for (const user of existing.data) {
      await client.users.deleteUser(user.id);
    }
  } catch {
    // Cleanup is best-effort by design.
  }
}

/** Inserts the `users` mirror row exactly as the signed `user.created`
 * webhook would (role USER, server-controlled — see lib/server/clerk-sync.ts).
 * The session itself still has to come from a real Clerk sign-in. */
async function mirrorUserRowAfterWebhook(clerkUserId: string): Promise<void> {
  loadAppEnv(); // ensures DATABASE_URL is present before Prisma constructs
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to mirror the Clerk user row.");
  }
  const { prisma } = await import("@draftcourt/db");
  await prisma.user.upsert({
    where: { clerkUserId },
    update: {},
    create: { clerkUserId, role: "USER" },
  });
}
