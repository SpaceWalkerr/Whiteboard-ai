import { react } from "@whiteboard/config/eslint/react";

export default [
  ...react({ tsconfigRootDir: import.meta.dirname }),
  {
    // shadcn/ui components export variants alongside components by design.
    files: ["src/components/ui/**"],
    rules: { "react-refresh/only-export-components": "off" },
  },
];
