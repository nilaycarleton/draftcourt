import type { z } from "zod";
import type { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { ok, problem, problems } from "@/lib/api/envelope";
import {
  DraftError,
  DraftIllegalPickError,
  DraftNotFoundError,
  DraftStatusError,
  DraftVersionConflict,
} from "@/lib/server/drafts";
import { PreferenceSnapshotValidationError } from "@/lib/server/preference-snapshot";

/**
 * Shared helpers for `/api/v1/drafts/*` route modules: auth gate, error →
 * RFC 9457 problem mapping (version conflicts carry the authoritative state
 * so clients reconcile without a second read), and Zod field-error shaping.
 */

export interface RouteContext {
  params: Promise<{ id: string }>;
}

export function draftErrorToProblem(error: unknown): NextResponse | null {
  if (error instanceof DraftVersionConflict) {
    return problem({
      type: "/problems/version-conflict",
      title: "Conflict",
      status: 409,
      detail: error.message,
      authoritative: error.authoritative,
    });
  }
  if (error instanceof DraftStatusError) {
    return problem({
      type: "/problems/draft-status",
      title: "Conflict",
      status: 409,
      detail: error.message,
    });
  }
  if (error instanceof DraftIllegalPickError) {
    return problem({
      type: "/problems/illegal-pick",
      title: "Unprocessable Entity",
      status: 422,
      detail: error.message,
    });
  }
  if (error instanceof DraftNotFoundError) {
    return problem(problems.notFound("draft not found"));
  }
  if (error instanceof PreferenceSnapshotValidationError) {
    // Invalid stored preference data fails safely BEFORE draft start (Phase
    // 3B): the strategy is unusable, so starting is refused with an actionable
    // problem detail instead of capturing a broken snapshot.
    return problem({
      type: "/problems/invalid-strategy",
      title: "Unprocessable Entity",
      status: 422,
      detail: error.message,
    });
  }
  if (error instanceof DraftError) {
    return problem(problems.badRequest(error.message));
  }
  return null;
}

export async function requireUserId(): Promise<string | null> {
  const user = await getCurrentUser();
  return user?.id ?? null;
}

export function zodIssues(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    out[key] = [...(out[key] ?? []), issue.message];
  }
  return out;
}

export { ok, problem, problems };
