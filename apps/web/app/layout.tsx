import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

// The proxy issues a fresh CSP nonce per request; Next.js only applies that
// nonce to scripts during dynamic rendering (see
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
// Without this, statically prerendered routes ship build-time HTML whose
// scripts violate the runtime 'strict-dynamic' policy once Clerk is enabled.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "DraftCourt",
  description: "NBA fantasy live draft assistant — foundation build (Phase 0).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
