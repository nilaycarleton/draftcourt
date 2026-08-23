// @ts-check
import nextPlugin from "@next/eslint-plugin-next";
import { reactConfig } from "./react.js";

/** Adds Next.js core-web-vitals rules on top of the React config for `apps/web`. */
export const nextConfig = [
  ...reactConfig,
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
];

export default nextConfig;
