// Bundles the k6 scripts (TypeScript + the codec) into plain JS files k6 can run.
import { build } from "esbuild";

await build({
  entryPoints: ["src/k6/editors-one-room.ts", "src/k6/many-rooms.ts"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "neutral",
  external: ["k6", "k6/*"],
  logLevel: "info",
});
