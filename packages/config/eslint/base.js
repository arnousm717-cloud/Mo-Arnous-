// @ts-check
const tseslint = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

/** Shared base config for non-Next.js packages (packages/*). */
module.exports = [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // 10-CLAUDE.md §1: named exports only — no default exports in packages/*.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "No default exports in packages/* — use named exports (10-CLAUDE.md §1).",
        },
      ],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", ".turbo/**"],
  },
];
