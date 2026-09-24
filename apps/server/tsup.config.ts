import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so they are bundled into the server build.
// Third-party dependencies stay external and are installed on the host.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  noExternal: [/^@whiteboard\//],
});
