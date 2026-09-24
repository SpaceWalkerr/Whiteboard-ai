import globals from "globals";
import { base } from "./base.js";

/**
 * @param {{ tsconfigRootDir: string }} options
 */
export function node(options) {
  return [...base(options), { languageOptions: { globals: globals.node } }];
}
