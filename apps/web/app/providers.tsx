"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "@draftcourt/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useState, type ReactNode } from "react";
import { SentryInit } from "./sentry-init";

const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  const content = (
    // reducedMotion="user": any current or future Motion-driven animation
    // collapses automatically under prefers-reduced-motion (Phase 3F motion;
    // see ADR 0017). Today's token-driven CSS transitions already collapse
    // via --dc-motion-duration-* tokens.
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <SentryInit />
          {children}
        </ThemeProvider>
      </QueryClientProvider>
    </MotionConfig>
  );

  // Clerk requires real keys; without them (local/CI without secrets) we skip
  // the provider entirely rather than let it throw. See lib/env.ts.
  if (!clerkPublishableKey) {
    return content;
  }

  return <ClerkProvider publishableKey={clerkPublishableKey}>{content}</ClerkProvider>;
}
