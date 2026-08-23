// @ts-check
import { reactConfig } from "@draftcourt/config-eslint/react";

export default [
  ...reactConfig,
  {
    ignores: ["dist/**", "storybook-static/**"],
  },
];
