import type { NextResponse } from "next/server";
import { ok, problem, problems } from "@/lib/api/envelope";
import { getPlayerProfile } from "@/lib/server/player-profile";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  if (!slug || slug.length > 100) {
    return problem(problems.badRequest("A valid player slug is required."));
  }

  const profile = await getPlayerProfile(slug);
  if (!profile) {
    return problem(problems.notFound(`No player found for slug "${slug}".`));
  }

  return ok(profile, {
    projectionRunId: profile.projectionRun?.runId ?? null,
    modelVersion: profile.projectionRun?.modelVersion ?? null,
    demoData: true,
  });
}
