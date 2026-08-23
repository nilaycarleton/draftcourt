import type { NextResponse } from "next/server";
import { ok } from "@/lib/api/envelope";
import { listDataSources } from "@/lib/server/data-sources";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const sources = await listDataSources();
  return ok(sources, { demoData: true });
}
