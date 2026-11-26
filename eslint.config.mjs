import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Flat ESLint config.
 *
 * We compose it from the individual plugins instead of `eslint-config-next`
 * because that package still relies on @rushstack/eslint-patch, which cannot
 * patch ESLint 9's module resolution (it throws before any file is linted).
 * The rule coverage is the same: Next.js core-web-vitals + React hooks +
 * TypeScript recommended.
 */
export default tseslint.config(
  {
    ignores: [".next/**", "node_modules/**", "data/**", "dist/**", "test-results/**", "playwright-report/**", "next-env.d.ts"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.ts", "e2e/**/*.ts", "*.config.ts"],
    rules: { "no-console": "off", "@typescript-eslint/no-explicit-any": "off" },
  }
);
