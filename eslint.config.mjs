import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  {
    // The existing application predates the opt-in React Compiler rules. Keep
    // the established runtime behavior while retaining the core Hooks checks.
    rules: {
      "react-hooks/static-components": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react/no-unescaped-entities": "warn",
      "react/jsx-key": "warn",
      "@next/next/no-assign-module-variable": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "dev-tooling/**",
  ]),
]);
