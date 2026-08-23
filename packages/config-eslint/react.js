// @ts-check
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
import { base } from "./base.js";

/** Adds React/JSX/a11y rules on top of the shared base for `packages/ui`-style libraries. */
export const reactConfig = [
  ...base,
  {
    files: ["**/*.tsx", "**/*.jsx"],
    ...react.configs.flat.recommended,
  },
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["**/*.tsx", "**/*.jsx"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    settings: {
      react: { version: "19.2" },
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // A scrollable `role="region"` container (a wide table/data grid on
      // a narrow viewport) genuinely needs `tabIndex={0}` so keyboard
      // users can reach and scroll it — this is axe-core's own documented
      // `scrollable-region-focusable` pattern, which this rule's default
      // config otherwise flags as a false positive.
      "jsx-a11y/no-noninteractive-tabindex": ["error", { roles: ["region"] }],
    },
  },
];

export default reactConfig;
