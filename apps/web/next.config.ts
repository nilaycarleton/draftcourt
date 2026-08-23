import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@draftcourt/ui", "@draftcourt/domain", "@draftcourt/db"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
