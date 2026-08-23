import type { NextRequest, NextResponse } from "next/server";
import { prisma } from "@draftcourt/db";
import { ok, problem, problems, newTraceId } from "@/lib/api/envelope";
import { requireAdminOrProblem } from "@/lib/api/admin-guard";
import { createSignal, listSignals } from "@/lib/server/admin-signals";
import { createSignalSchema } from "@/lib/server/admin-validation";
import { compact } from "@/lib/compact";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdminOrProblem();
  if ("response" in guard) return guard.response;

  const { searchParams } = new URL(request.url);
  const signals = await listSignals(
    compact({
      playerId: searchParams.get("playerId") ?? undefined,
      activeOnly: searchParams.get("activeOnly") === "true",
    }),
  );
  return ok(signals);
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

  const parsed = createSignalSchema.safeParse(body);
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
  const signal = await createSignal({
    adminId: guard.user.id,
    playerId: input.playerId,
    type: input.type,
    impact: input.impact,
    confidence: input.confidence,
    rationale: input.rationale ?? null,
    effectiveAt: new Date(input.effectiveAt),
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    traceId,
  });

  return ok(signal, { traceId });
}
