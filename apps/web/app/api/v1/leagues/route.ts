import type { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { ok, problem, problems } from "@/lib/api/envelope";
import { zodIssuesToFieldErrors } from "@/lib/server/players-query";
import {
  createLeague,
  createLeagueSchema,
  listLeagues,
  LeagueValidationError,
} from "@/lib/server/leagues";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());

  const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
  const limitRaw = request.nextUrl.searchParams.get("limit");
  const limit = limitRaw !== null ? Number(limitRaw) : undefined;

  try {
    const { leagues, nextCursor } = await listLeagues(user.id, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
    return ok(leagues, { nextCursor, hasMore: nextCursor !== null });
  } catch {
    return problem(problems.internal());
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(problems.badRequest("request body must be JSON"));
  }

  const parsed = createLeagueSchema.safeParse(body);
  if (!parsed.success) {
    return problem(problems.validation(zodIssuesToFieldErrors(parsed.error.issues)));
  }

  try {
    const league = await createLeague(user.id, parsed.data);
    return ok(league);
  } catch (error) {
    if (error instanceof LeagueValidationError) {
      return problem(problems.validation({ config: [error.message] }));
    }
    console.error("[leagues] create failed", error);
    return problem(problems.internal());
  }
}
