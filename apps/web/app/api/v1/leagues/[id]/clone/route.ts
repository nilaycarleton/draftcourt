import type { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { ok, problem, problems } from "@/lib/api/envelope";
import { cloneLeague } from "@/lib/server/leagues";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    // Null covers both missing and not-owned source leagues (no enumeration).
    const clone = await cloneLeague(user.id, id);
    if (!clone) return problem(problems.notFound("league not found"));
    return ok(clone);
  } catch (error) {
    console.error("[leagues] clone failed", error);
    return problem(problems.internal());
  }
}
