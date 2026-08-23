// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/** Shared strict base — Node/TypeScript packages without a UI framework. */
export const base = tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/storybook-static/**",
      "**/node_modules/**",
      "**/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          // Tooling/config files at a package root usually aren't part of
          // that package's own tsconfig "include" — lint them untyped
          // instead of failing with "not found by the project service".
          allowDefaultProject: ["*.config.{js,mjs,ts}", "*.setup.ts"],
        },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.config.{js,mjs,ts}", "**/*.setup.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);

export default base;
