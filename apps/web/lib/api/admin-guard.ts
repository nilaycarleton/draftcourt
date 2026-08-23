import type { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import type { CurrentUser } from "@/lib/server/auth";
import { problem, problems } from "@/lib/api/envelope";
import type { ApiError } from "@/lib/api/envelope";

/** Shared 401-vs-403 gate for every `/api/v1/admin/*` route: unauthenticated
 * gets 401, authenticated-but-not-admin gets a safe 403 — neither exposes
 * whether a given Clerk user ID exists in our system. */
export async function requireAdminOrProblem(): Promise<
  { user: CurrentUser } | { response: NextResponse<ApiError> }
> {
  const user = await getCurrentUser();
  if (!user) return { response: problem(problems.unauthorized()) };
  if (user.role !== "ADMIN") return { response: problem(problems.forbidden()) };
  return { user };
}
