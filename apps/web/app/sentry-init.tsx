"use client";

// Side-effect import: runs Sentry.init() in the browser bundle only. Kept in
// a client component (rather than imported directly from the server-rendered
// root layout) so sentry.client.config.ts never executes during SSR.
import "../sentry.client.config";

export function SentryInit() {
  return null;
}
