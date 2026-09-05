import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy } from "./lib/content-security-policy";
import { isClerkConfigured } from "./lib/env";

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function withSecurityHeaders(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy(nonce);

  // Next.js extracts the nonce for its own bootstrap scripts from the
  // Content-Security-Policy REQUEST header during SSR; without it,
  // 'strict-dynamic' blocks every first-party and Clerk script.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

// Clerk requires real keys to run; in local/CI environments without secrets
// (see .env.example) we skip it and only apply the CSP/nonce middleware —
// documented as an intentionally-disabled optional integration per
// BUILD_SPEC.md section 15.
export default isClerkConfigured
  ? clerkMiddleware((_auth, request) => withSecurityHeaders(request))
  : withSecurityHeaders;

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
