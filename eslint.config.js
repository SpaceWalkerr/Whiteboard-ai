// Root config only covers files at the repo root (Node scripts and tool configs); each
// workspace package has its own config.
import { node } from "@whiteboard/config/eslint/node";

export default [
  { ignores: ["apps/**", "packages/**"] },
  ...node({ tsconfigRootDir: import.meta.dirname }),
];
