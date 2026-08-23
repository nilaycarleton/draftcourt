// @ts-check
import { nextConfig } from "@draftcourt/config-eslint/next";

export default [
  ...nextConfig,
  {
    ignores: [".next/**", "playwright-report/**", "test-results/**"],
  },
];
