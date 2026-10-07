import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", ".wrangler/**", "node_modules/**", "worker-configuration.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // `_name` marks a value left out on purpose (e.g. `const { id: _id, ...rest } = row`).
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true, caughtErrors: "none",
      }],
      // Input sanitizing deliberately matches control characters (\u0000-\u001f) to strip or reject them.
      "no-control-regex": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "AssignmentExpression[left.property.name='innerHTML']",
          message: "Do not assign innerHTML (XSS risk).",
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML is not allowed (XSS risk). Sanitize on the server and render text.",
        },
      ],
    },
  },
  {
    files: ["src/client/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Worker logs are structured JSON lines read in Workers Logs (shape enforced by scripts/static-checks.ts).
    files: ["src/worker/**/*.ts"],
    languageOptions: { globals: globals.serviceworker },
    rules: { "no-console": "off" },
  },
  {
    files: ["tests/**/*.{ts,tsx}", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    // Command-line tools: Node globals, and printing to the terminal is their job.
    files: ["scripts/**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },
  {
    // Browser suites: Node runner + code that runs inside the page (page.evaluate).
    files: ["tests/e2e/**/*.{js,mjs,mts}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "no-console": "off" },
  },

);
