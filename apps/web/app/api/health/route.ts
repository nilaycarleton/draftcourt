import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    data: {
      status: "ok",
      service: "web",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
    error: null,
    meta: { traceId: crypto.randomUUID() },
  });
}
