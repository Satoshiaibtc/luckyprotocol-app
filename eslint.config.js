// Flat ESLint config (ESLint v9+ format).
//
// Mirrors luckyprotocol-web/eslint.config.js: a SAFETY-NET lint, not a
// style enforcer. Build-breaking rules are the ones that catch real
// correctness bugs (conditional hooks, undefined globals, duplicate keys,
// unreachable code, forgotten debugger/alert). Everything else warns.
//
//   npm run lint       — report
//   npm run lint:fix   — auto-fix what's fixable

import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "*.config.js"],
  },

  js.configs.recommended,

  // Browser-side app code.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Core `no-unused-vars` cannot see identifiers used only in JSX
      // (<TopBar />); this rule marks them as used. That is the ONLY rule
      // we take from eslint-plugin-react.
      "react/jsx-uses-vars": "error",

      // ----- real-bug catchers (error) -----
      "react-hooks/rules-of-hooks": "error",
      "no-debugger": "error",
      "no-alert": "error",
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],

      // ----- soft warnings -----
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",

      // ----- React-specific guardrails -----
      "react-refresh/only-export-components": "off",
    },
  },

  // Node-side test scripts (plain `node test/...`, no framework) and build scripts.
  {
    files: ["test/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
