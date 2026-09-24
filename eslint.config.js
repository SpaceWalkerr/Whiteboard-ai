// Root config only covers files at the repo root; each workspace package has its own config.
import { base } from "@whiteboard/config/eslint/base";

export default [
  { ignores: ["apps/**", "packages/**"] },
  ...base({ tsconfigRootDir: import.meta.dirname }),
];
