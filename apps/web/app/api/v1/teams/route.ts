import type { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { ok, problem, problems } from "@/lib/api/envelope";
import { prisma } from "@draftcourt/db";

export const dynamic = "force-dynamic";

/** GET /api/v1/teams?q=… — authenticated team metadata lookup for the
 * preference editor (public reference data; no secrets, no pagination
 * complexity — the NBA has 30 teams). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return problem(problems.unauthorized());

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  try {
    const teams = await prisma.nbaTeam.findMany({
      ...(q
        ? {
            where: {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { city: { contains: q, mode: "insensitive" } },
                { abbreviation: { contains: q, mode: "insensitive" } },
              ],
            },
          }
        : {}),
      select: { id: true, name: true, city: true, abbreviation: true },
      orderBy: { abbreviation: "asc" },
    });
    const response = ok(teams);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("[teams] list failed", error);
    return problem(problems.internal());
  }
}
