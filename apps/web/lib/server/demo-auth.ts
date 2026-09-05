import type { NextRequest } from "next/server";
import { problem } from "@/lib/api/envelope";
import type { NextResponse } from "next/server";

export const DEMO_CAPABILITY_COOKIE = "__Secure-demo-capability";

export class DemoAuthError extends Error {
  constructor(public readonly response: NextResponse) {
    super("Demo auth failed");
  }
}

export function extractCapabilityToken(request: NextRequest): string | null {
  const cookieToken = request.cookies.get(DEMO_CAPABILITY_COOKIE)?.value;
  if (cookieToken) return cookieToken;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  return null;
}

export function requireCapabilityToken(request: NextRequest): string {
  const token = extractCapabilityToken(request);
  if (!token) {
    throw new DemoAuthError(
      problem({
        type: "/problems/demo-unauthorized",
        title: "Unauthorized",
        status: 401,
        detail: "Demo capability token required",
      }),
    );
  }
  return token;
}

export function handleDemoError(error: unknown): NextResponse | null {
  if (error instanceof DemoAuthError) return error.response;
  // Additional error handling can be added here
  return null;
}
