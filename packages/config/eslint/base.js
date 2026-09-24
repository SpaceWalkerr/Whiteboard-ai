// Shared flat-config preset. Type-aware rules are on for TS files; plain JS config files
// (eslint.config.js etc.) are linted without type information.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * @param {{ tsconfigRootDir: string }} options directory of the package's tsconfig.json
 */
export function base({ tsconfigRootDir }) {
  return tseslint.config(
    { ignores: ["**/dist/**", "**/coverage/**", "**/playwright-report/**", "**/test-results/**"] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      rules: {
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { fixStyle: "inline-type-imports" },
        ],
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
        "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
        eqeqeq: ["error", "always"],
        "no-console": "error",
      },
    },
    {
      files: ["**/*.{js,mjs,cjs}"],
      ...tseslint.configs.disableTypeChecked,
    },
    prettier,
  );
}
