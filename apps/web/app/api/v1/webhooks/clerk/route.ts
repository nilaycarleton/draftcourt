import { Webhook, WebhookVerificationError } from "svix";
import { env, isClerkConfigured } from "@/lib/env";
import { ok, problem, problems } from "@/lib/api/envelope";
import { syncClerkUserEvent } from "@/lib/server/clerk-sync";

/**
 * `POST /api/v1/webhooks/clerk` — the signed Clerk → DraftCourt user mirror
 * (the seam ADR 0009 designed and left as the documented Phase 1 gap).
 *
 * - Signature verification uses svix (Clerk signs with svix/standardwebhooks)
 *   against the RAW request body — never a re-serialized one — with
 *   `CLERK_WEBHOOK_SIGNING_SECRET`. Svix's verification enforces the
 *   timestamp tolerance (replay window) and signature match; failures are 401.
 * - When Clerk is not configured (local dev without keys) the route answers
 *   503 rather than pretending to process events.
 * - Payload handling/redaction rules live in lib/server/clerk-sync.ts.
 */

interface WebhookHandlerDeps {
  signingSecret: string;
}

export function createClerkWebhookHandler(deps: WebhookHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    if (!deps.signingSecret) {
      return problem(
        {
          type: "/problems/service-unavailable",
          title: "Service Unavailable",
          status: 503,
          detail: "Clerk webhook is not configured on this deployment.",
        },
        { traceId: crypto.randomUUID() },
      );
    }

    const payload = await request.text();
    const headers = Object.fromEntries(request.headers.entries());

    const wh = new Webhook(deps.signingSecret);
    let event: unknown;
    try {
      event = wh.verify(payload, headers);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return problem(problems.unauthorized("webhook signature verification failed"));
      }
      throw error;
    }

    if (typeof event !== "object" || event === null || !("type" in event) || !("data" in event)) {
      return problem(problems.badRequest("unrecognized webhook payload shape"));
    }

    try {
      await syncClerkUserEvent(event as { type: string; data: Record<string, unknown> });
    } catch (error) {
      // Surface only a safe problem to Clerk; details go to logs/Sentry.
      console.error("[clerk-webhook] sync failed", error);
      return problem(problems.internal("user mirror sync failed; the delivery will be retried"));
    }

    return ok({ received: true });
  };
}

export const maxDuration = 15;

/** Configured once per deployment; 503s when Clerk keys are absent. */
export const POST = createClerkWebhookHandler({
  signingSecret:
    isClerkConfigured && env.CLERK_WEBHOOK_SIGNING_SECRET ? env.CLERK_WEBHOOK_SIGNING_SECRET : "",
});
