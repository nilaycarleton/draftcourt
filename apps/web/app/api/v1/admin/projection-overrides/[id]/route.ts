import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ok, problem, problems } from "@/lib/api/envelope";
import { requireAdminOrProblem } from "@/lib/api/admin-guard";
import { revokeOverride } from "@/lib/server/admin-overrides";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  action: z.literal("revoke"),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const guard = await requireAdminOrProblem();
  if ("response" in guard) return guard.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(problems.badRequest("Request body must be valid JSON."));
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return problem(problems.badRequest('Only {"action":"revoke"} is supported.'));
  }

  const updated = await revokeOverride({
    id,
    adminId: guard.user.id,
    traceId: crypto.randomUUID(),
  });
  if (!updated) return problem(problems.notFound("No override found for the given id."));

  return ok(updated);
}
