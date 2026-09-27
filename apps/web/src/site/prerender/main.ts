import { loadEnv } from "@whiteboard/shared/env";
import { webEnvSchema } from "@whiteboard/shared/env/web";
import { prerenderSite } from "./prerender";

/**
 * Entry of the Node bundle built by `vite build --ssr` (dist-ssr/main.js). The browser build
 * runs it (scripts/prerenderPlugin.ts) with the output directory as its only argument. The
 * public env is the one baked into this bundle, i.e. the same as the browser bundle's.
 *
 * No top-level await: lazily loaded page chunks import shared code from this module, and
 * they couldn't finish loading while this module is still evaluating (a deadlock).
 */
function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("usage: node dist-ssr/main.js <outDir>");
  return prerenderSite({
    outDir,
    env: loadEnv(webEnvSchema, import.meta.env),
    production: process.env.VERCEL_ENV === "production",
    log: (message) => {
      process.stdout.write(`[prerender] ${message}\n`);
    },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[prerender] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
