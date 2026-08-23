import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/server/auth";
import { zodIssuesToFieldErrors } from "@/lib/server/players-query";
import { ok, problem, problems } from "@/lib/api/envelope";
import {
  deleteLeague,
  getLeagueDetail,
  LeagueNotFoundError,
  LeagueRuleLockedError,
  updateLeagueMeta,
  updateLeagueRules,
} from "@/lib/server/leagues";

export const dynamic = "force-dynamic";

const metaPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  playoffWeeks: z.number().int().min(1).max(14).nullable().optional(),
});

const rulesPatchSchema = z.object({
  config: z.object({
    type: z.enum(["POINTS", "CATEGORIES"]),
    horizon: z.enum(["REDRAFT", "KEEPER", "DYNASTY"]),
    playoffWeeks: z.number().int().min(1).max(14).nullable(),
    scoringRules: z.array(z.unknown()),
    rosterSlots: z.array(z.unknown()),
  }),
});

function errorToProblem(error: unknown): NextResponse | null {
  if (error instanceof LeagueNotFoundError) {
    return problem(problems.notFound("league not found"));
  }
  if (error instanceof LeagueRuleLockedError) {
    return problem({
      type: "/problems/conflict",
      title: "Conflict",
      status: 409,
      detail: error.message,
    });
  }
  return null;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    const detail = await getLeagueDetail(user.id, id);
    // getLeagueDetail returns null for both missing and not-owned ids.
    if (!detail) return problem(problems.notFound("league not found"));
    return ok(detail);
  } catch (error) {
    const mapped = errorToProblem(error);
    if (mapped) return mapped;
    console.error("[leagues] get failed", error);
    return problem(problems.internal());
  }
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(problems.badRequest("request body must be JSON"));
  }

  try {
    // A body with `config` edits rules (new settings version); otherwise it
    // patches mutable metadata only.
    const isRulesEdit =
      typeof body === "object" && body !== null && "config" in (body as Record<string, unknown>);

    if (isRulesEdit) {
      const parsed = rulesPatchSchema.safeParse(body);
      if (!parsed.success) {
        return problem(problems.validation(zodIssuesToFieldErrors(parsed.error.issues)));
      }
      const league = await updateLeagueRules(user.id, id, parsed.data.config as never);
      return ok(league);
    }

    const parsed = metaPatchSchema.safeParse(body);
    if (!parsed.success) {
      return problem(problems.validation(zodIssuesToFieldErrors(parsed.error.issues)));
    }
    const league = await updateLeagueMeta(user.id, id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.playoffWeeks !== undefined ? { playoffWeeks: parsed.data.playoffWeeks } : {}),
    });
    return ok(league);
  } catch (error) {
    const mapped = errorToProblem(error);
    if (mapped) return mapped;
    console.error("[leagues] patch failed", error);
    return problem(problems.internal());
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());
  const { id } = await context.params;

  try {
    await deleteLeague(user.id, id);
    return ok({ deleted: true });
  } catch (error) {
    const mapped = errorToProblem(error);
    if (mapped) return mapped;
    console.error("[leagues] delete failed", error);
    return problem(problems.internal());
  }
}
