import type { NextRequest, NextResponse } from "next/server";
import { prisma } from "@draftcourt/db";
import { ok, problem, problems, newTraceId } from "@/lib/api/envelope";
import { requireAdminOrProblem } from "@/lib/api/admin-guard";
import { createOverride, listOverrides } from "@/lib/server/admin-overrides";
import { createOverrideSchema } from "@/lib/server/admin-validation";
import { compact } from "@/lib/compact";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdminOrProblem();
  if ("response" in guard) return guard.response;

  const { searchParams } = new URL(request.url);
  const overrides = await listOverrides(
    compact({
      playerId: searchParams.get("playerId") ?? undefined,
      status: searchParams.get("status") ?? undefined,
    }),
  );
  return ok(overrides);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdminOrProblem();
  if ("response" in guard) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(problems.badRequest("Request body must be valid JSON."));
  }

  const parsed = createOverrideSchema.safeParse(body);
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "body";
      errors[key] = [...(errors[key] ?? []), issue.message];
    }
    return problem(problems.validation(errors));
  }
  const input = parsed.data;

  const player = await prisma.player.findUnique({
    where: { id: input.playerId },
    select: { id: true },
  });
  if (!player) return problem(problems.notFound("No player found for the given playerId."));

  const traceId = newTraceId();
  const result = await createOverride({
    adminId: guard.user.id,
    playerId: input.playerId,
    season: input.season,
    stat: input.stat,
    deltaValue: input.deltaValue ?? null,
    replacementValue: input.replacementValue ?? null,
    rationale: input.rationale,
    effectiveAt: new Date(input.effectiveAt),
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
    traceId,
  });

  if (!result.ok) {
    return problem(problems.badRequest("supersedesId does not reference an active override."), {
      traceId,
    });
  }

  return ok(result.override, { traceId });
}
