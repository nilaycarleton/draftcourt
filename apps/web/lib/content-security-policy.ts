/**
 * Builds a nonce-based Content-Security-Policy header value. Kept as a pure
 * function (no Next.js imports) so it is unit-testable without a running
 * server — see content-security-policy.test.ts. Consumed by middleware.ts,
 * which generates a fresh nonce per request.
 *
 * Clerk and Sentry hosts are allowlisted because both are wired as Phase 0
 * scaffolding (see docs/adr/0004-local-dev-and-deployment-foundations.md);
 * neither requires 'unsafe-inline'.
 */
export function buildContentSecurityPolicy(nonce: string): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "https://*.clerk.accounts.dev",
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      "https://*.clerk.accounts.dev",
      "https://*.sentry.io",
      "https://*.ingest.sentry.io",
    ],
    "frame-src": ["'self'", "https://*.clerk.accounts.dev"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "upgrade-insecure-requests": [],
  };

  return Object.entries(directives)
    .map(([directive, values]) =>
      values.length > 0 ? `${directive} ${values.join(" ")}` : directive,
    )
    .join("; ");
}
