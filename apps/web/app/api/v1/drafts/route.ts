import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@draftcourt/db";
import {
  draftErrorToProblem,
  ok,
  problem,
  problems,
  requireUserId,
  zodIssues,
} from "@/lib/api/draft-route-helpers";
import { createDraft } from "@/lib/server/drafts";

export const dynamic = "force-dynamic";

const createDraftSchema = z.object({
  leagueId: z.uuid(),
  type: z.enum(["REAL", "MOCK", "DEMO"]).default("REAL"),
  keepers: z
    .array(
      z.object({
        playerId: z.uuid(),
        teamSlot: z.number().int().min(1).max(20),
      }),
    )
    .max(60)
    .default([]),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(problems.badRequest("request body must be JSON"));
  }

  const parsed = createDraftSchema.safeParse(body);
  if (!parsed.success) {
    return problem(problems.validation(zodIssues(parsed.error)));
  }

  try {
    const draft = await createDraft(userId, parsed.data);
    return ok(draft);
  } catch (error) {
    const mapped = draftErrorToProblem(error);
    if (mapped) return mapped;
    console.error("[drafts] create failed", error);
    return problem(problems.internal());
  }
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const userId = await requireUserId();
  if (!userId) return problem(problems.unauthorized());

  try {
    const drafts = await prisma.draft.findMany({
      where: { ownerId: userId },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        leagueId: true,
        type: true,
        status: true,
        currentSequence: true,
        nextOverallPick: true,
        version: true,
        updatedAt: true,
      },
    });
    return ok(drafts);
  } catch (error) {
    console.error("[drafts] list failed", error);
    return problem(problems.internal());
  }
}
