import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ok, problem, problems } from "@/lib/api/envelope";
import { comparePlayers } from "@/lib/server/player-profile";

export const dynamic = "force-dynamic";

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

const bodySchema = z.object({
  slugs: z
    .array(z.string().min(1).max(100))
    .min(MIN_PLAYERS, `At least ${String(MIN_PLAYERS)} player slugs are required.`)
    .max(MAX_PLAYERS, `At most ${String(MAX_PLAYERS)} player slugs may be compared at once.`),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(problems.badRequest("Request body must be valid JSON."));
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "slugs";
      errors[key] = [...(errors[key] ?? []), issue.message];
    }
    return problem(problems.validation(errors));
  }

  const { slugs } = parsed.data;
  const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
  if (duplicates.length > 0) {
    return problem(
      problems.badRequest(
        `Duplicate player slugs are not allowed: ${[...new Set(duplicates)].join(", ")}.`,
      ),
    );
  }

  const profiles = await comparePlayers(slugs);
  const foundSlugs = new Set(profiles.map((p) => p.slug));
  const missing = slugs.filter((slug) => !foundSlugs.has(slug));
  if (missing.length > 0) {
    return problem(problems.notFound(`No player found for slug(s): ${missing.join(", ")}.`));
  }

  // Preserve the caller's requested order rather than whatever order the
  // database happened to return.
  const bySlug = new Map(profiles.map((profile) => [profile.slug, profile]));
  const ordered = slugs.map((slug) => bySlug.get(slug)).filter((p) => p !== undefined);

  return ok(ordered, { demoData: true });
}
