import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import { base } from "./base.js";

/**
 * @param {{ tsconfigRootDir: string }} options
 */
export function react(options) {
  return [
    ...base(options),
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: { globals: globals.browser },
      plugins: {
        "react-hooks": reactHooks,
        "react-refresh": reactRefresh,
      },
      rules: {
        ...reactHooks.configs.recommended.rules,
        "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
      },
    },
    jsxA11y.flatConfigs.strict,
  ];
}
